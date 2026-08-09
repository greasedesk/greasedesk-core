/**
 * File: pages/api/stripe/checkout.ts
 * POST → a hosted Stripe Checkout Session URL (item-12). ADMIN-only. Subscription mode, ONE Price
 * selected by the tenant's COUNTRY PROFILE currency (GB £75 / US $100 / IE €90, ruling 2026-07-28),
 * quantity = the tenant's site count. Card VERIFIED + 3DS-authenticated at day 1 but NOT charged
 * (trial_period_days), so the day-61 conversion is an OFF-SESSION charge against an authenticated
 * card with an established mandate — it cannot fail SCA.
 *   BOTH HALVES OR NEITHER: before creating a session the selected Price is RETRIEVED and its
 *   amount + currency asserted against the profile's monthlyPrice — a misconfigured Price (the
 *   £35 drift) refuses loudly instead of showing one figure and charging another.
 *   payment_method_collection:'always' → a card is required to start the trial (no card, no trial).
 *   Stripe Tax is enabled ONLY when GreaseDesk Ltd is VAT-registered (NEXT_PUBLIC_GARAGE_VAT_
 *   REGISTERED). The billing ADDRESS is collected either way — see below.
 *   client_reference_id = group_id → the webhook maps the subscription back with zero trust in the
 *   redirect. The redirect writes NOTHING; the webhook is the ledger.
 * Idempotency key = group_id + site count, so a double-submit reuses one session.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { prisma } from '@/lib/db';
import { requireAdminApi } from '@/lib/admin-guard';
import { getStripe, stripePriceId, appBaseUrl, TRIAL_PERIOD_DAYS } from '@/lib/stripe';
import { createHash } from 'node:crypto';
import type Stripe from 'stripe';
import { writeAudit } from '@/lib/audit';
import { garageVatRegistered } from '@/lib/billing-pricing';

/**
 * What the Price must say about tax. A CONSTANT rather than a config value on purpose: this is not
 * a preference, it is what Terms v2 commits us to, and it should take a code change and a review to
 * alter — not an env var somebody can flip at 6pm.
 */
const EXPECTED_TAX_BEHAVIOR = 'inclusive' as const;
import { resolveTenantProfile } from '@/lib/locale-profiles';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).json({ message: 'Method Not Allowed' }); }
  const vis = await requireAdminApi(req, res); if (!vis) return;

  const stripe = getStripe();
  if (!stripe) return res.status(503).json({ message: 'Billing isn’t configured yet.' });

  const groupId = vis.groupId as string;
  if (!groupId) return res.status(400).json({ message: 'No group in scope.' });
  const [group, siteCount, billing] = await Promise.all([
    prisma.group.findUnique({ where: { id: groupId }, select: { group_name: true, billing_email: true, country_code: true, ref: true } }),
    prisma.site.count({ where: { group_id: groupId } }),
    prisma.groupBilling.findUnique({ where: { group_id: groupId }, select: { stripe_customer_id: true } }),
  ]);
  if (!group) return res.status(404).json({ message: 'Group not found.' });

  // GBP-ONLY, TAX-INCLUSIVE PRICE (model changed 2026-08-09, superseding the multi-currency one).
  // The session still passes the profile's currency; there is simply one option to resolve to.
  const profile = resolveTenantProfile(group);
  const priceId = stripePriceId();
  if (!priceId) return res.status(503).json({ message: 'Billing isn’t configured yet.' });
  const wantCurrency = profile.currency.toLowerCase();
  // BOTH HALVES OR NEITHER: the Price must carry an option for the tenant's currency and that
  // option must charge exactly what the profile displays. currency_options is NOT in the default
  // payload — it needs the expand. No option → REFUSE, never default to the GBP base.
  try {
    const price = await stripe.prices.retrieve(priceId, { expand: ['currency_options'] });
    const wantAmount = Math.round(profile.monthlyPrice * 100);
    const optionAmount = price.currency === wantCurrency
      ? price.unit_amount
      : (price.currency_options?.[wantCurrency]?.unit_amount ?? null);
    if (optionAmount == null) {
      console.error(`[stripe] price ${priceId} has NO currency option for ${wantCurrency} (tenant country ${profile.countryCode}) — refusing checkout`);
      return res.status(503).json({ message: 'Billing isn’t configured for your country yet.' });
    }
    if (optionAmount !== wantAmount) {
      console.error(`[stripe] PRICE MISMATCH: ${priceId} ${wantCurrency} option is ${optionAmount}, profile says ${wantAmount} — refusing checkout`);
      return res.status(503).json({ message: 'Billing configuration is being updated — please try again shortly.' });
    }
    // ── AND THE TAX BEHAVIOUR, WHICH THE AMOUNT CANNOT REVEAL ──────────────────────────────────
    // The old exclusive price and the new inclusive one are BOTH £75 in GBP. They differ in one
    // field, and it decides whether the customer pays £75 or £90 — so an amount-only guard would
    // have passed a swapped price silently and for ever. Terms v2 (effective 2026-08-09) states the
    // price INCLUDES VAT, so anything else is not merely a misconfiguration, it is a term we are
    // no longer entitled to charge on.
    //
    // Checked on the resolved option, not just the base: currency_options carry their own
    // tax_behavior and could in principle disagree with the top-level one.
    const optionTaxBehavior = price.currency === wantCurrency
      ? price.tax_behavior
      : (price.currency_options?.[wantCurrency]?.tax_behavior ?? null);
    if (optionTaxBehavior !== EXPECTED_TAX_BEHAVIOR) {
      console.error(`[stripe] TAX BEHAVIOUR MISMATCH: ${priceId} ${wantCurrency} is '${optionTaxBehavior}', expected '${EXPECTED_TAX_BEHAVIOR}' — refusing checkout`);
      return res.status(503).json({ message: 'Billing configuration is being updated — please try again shortly.' });
    }
  } catch (e: any) {
    console.error('[stripe] price retrieve failed', e?.message);
    return res.status(503).json({ message: 'Billing configuration is being updated — please try again shortly.' });
  }
  // ── THE CUSTOMER IS OURS TO CREATE, AND OURS TO PUT A COUNTRY ON ────────────────────────────
  // Left to Checkout, the customer's country came from the payer's browser/IP, falling back to our
  // own Stripe account's country — so a US tenant signed up from a UK connection was recorded as
  // GB. We already resolved that country to pick the currency two lines above; sending it costs
  // nothing and makes it the value the payer SEES prefilled rather than one they have to notice is
  // wrong. Idempotency-keyed on the group, so a retried or failed checkout cannot spawn duplicates.
  let customerId = billing?.stripe_customer_id ?? null;
  if (!customerId) {
    try {
      const customerParams: Stripe.CustomerCreateParams = {
        email: group.billing_email ?? undefined,
        name: group.group_name ?? undefined,
        address: { country: profile.countryCode },   // the ONLY field we assert; the rest is theirs
        metadata: { group_id: groupId, group_ref: group.ref ?? '' },
      };
      // The key carries the PARAMETERS, for the same reason the session key does: a group-only key
      // is rejected by Stripe the moment anything about the customer differs — and the first thing
      // that differs is the country, which is the whole point of this call. Caught by the gate: a
      // tenant that moved US → GB got no customer and no country at all, silently.
      // Duplicate protection is not weakened: the `if (!customerId)` check above reads the id we
      // persist immediately, so the normal path never reaches here twice.
      const cShape = createHash('sha256').update(JSON.stringify(customerParams)).digest('hex').slice(0, 16);
      const customer = await stripe.customers.create(customerParams, { idempotencyKey: `customer:${groupId}:${cShape}` });
      customerId = customer.id;
      // Persist immediately: the webhook also writes this, but a customer we created and then
      // forgot would be an orphan of exactly the kind purgeTenant cannot reach.
      await prisma.groupBilling.update({ where: { group_id: groupId }, data: { stripe_customer_id: customerId } }).catch(() => {});
    } catch (e: any) {
      // FALLING THROUGH LOSES THE COUNTRY, which is the fault this whole path exists to fix — so it
      // is recorded, not just logged. Checkout still proceeds via customer_email: a guessed country
      // beats no checkout, but nobody should have to infer from silence that it happened.
      console.error('[stripe] customer create failed — country not sent', e?.message);
      await writeAudit(prisma as any, {
        groupId, userId: vis.userId ?? null,
        action: 'billing.country_not_sent', entity: 'group', entityId: groupId,
        diff: { intendedCountry: profile.countryCode, detail: String(e?.message ?? '').slice(0, 200), stripeCode: e?.code ?? null },
      }).catch(() => {});
      customerId = null;
    }
  }

  const quantity = Math.max(1, siteCount);
  const base = appBaseUrl();

  // Onboarding returns INTO the wizard (item-13) so completion is confirmed by a synchronous
  // session retrieve on the billing step — never left at Settings → Licence. The settings-page
  // "Start subscription" path keeps its own return URL.
  const onboarding = (req.body && (req.body as any).context === 'onboarding') === true;
  const successUrl = onboarding
    ? `${base}/onboarding/billing?session_id={CHECKOUT_SESSION_ID}`
    : `${base}/admin/settings/licences?billing=success`;
  const cancelUrl = onboarding
    ? `${base}/onboarding/billing?billing=cancelled`
    : `${base}/admin/settings/licences?billing=cancelled`;

  try {
    const params: Stripe.Checkout.SessionCreateParams = {
      mode: 'subscription',
      // Selects the currency option on the multi-currency Price — verified above to exist and to
      // match the profile's displayed amount.
      currency: wantCurrency,
      line_items: [{ price: priceId, quantity }],
      // Trial with a mandatory, authenticated card (see file header) — the SCA-safe conversion.
      // missing_payment_method: 'create_invoice' (ruling 2026-07-14): if the card is missing/fails
      // at trial end, ISSUE the invoice and let Stripe dunning chase for ~2 weeks — only THEN does
      // the sub go past_due → (later) lapsed. 'cancel' was the harshest reading of a soft failure —
      // it would drop the tenant into read-only mid-morning with no warning.
      subscription_data: {
        trial_period_days: TRIAL_PERIOD_DAYS,
        trial_settings: { end_behavior: { missing_payment_method: 'create_invoice' } },
      },
      payment_method_collection: 'always',
      // ── COLLECT THE ADDRESS ALWAYS, REGISTERED OR NOT ─────────────────────────────────────────
      // Stripe Tax cannot compute UK VAT without a customer address, and a customer created without
      // one keeps no address at all. Back-filling across a live base after registering means either
      // asking every customer to go and enter it, or guessing from what we hold — our Group.address
      // is a single free-text line, not Stripe's structured line1/city/postal_code/country, so
      // "guessing" means parsing addresses, which is how addresses go wrong. Collecting one we do
      // not yet need costs a field on a form we already show.
      billing_address_collection: 'required' as const,
      // Stripe Tax + VAT-ID capture ONLY when registered — tax-exclusive prices until then.
      ...(garageVatRegistered()
        ? { automatic_tax: { enabled: true }, tax_id_collection: { enabled: true } }
        : {}),
      client_reference_id: groupId,
      ...(customerId
        ? {
            customer: customerId,
            // REQUIRED the moment automatic_tax turns on: Stripe REFUSES a session that passes an
            // existing customer without it, and that day is chosen by HMRC rather than by us. It
            // also means an address corrected at Checkout or in the Portal lands on the customer
            // record Stripe Tax actually reads, instead of only on the session.
            customer_update: { address: 'auto' as const },
          }
        : { customer_email: group.billing_email ?? undefined }),
      success_url: successUrl,
      cancel_url: cancelUrl,
    };

    // ── THE KEY MUST DESCRIBE THE REQUEST, NOT JUST THE TENANT ────────────────────────────────
    // It used to be `checkout:${groupId}:${quantity}`, which says nothing about the SESSION. Stripe
    // rejects a reused idempotency key whose parameters differ, and the window is 24 hours — so any
    // change to the session shape (a new field, a different success_url, enabling Stripe Tax) made
    // the next call 502 for a whole day, for exactly the tenants who were mid-signup when it
    // deployed. Hashing the parameters means a changed shape is simply a NEW key, while an
    // unchanged one still replays — which is the double-click protection the key existed for.
    const shape = createHash('sha256').update(JSON.stringify(params)).digest('hex').slice(0, 16);
    const session = await stripe.checkout.sessions.create(params, {
      idempotencyKey: `checkout:${groupId}:${quantity}:${shape}`,
    });

    return res.status(200).json({ url: session.url });
  } catch (e: any) {
    // ── SAY WHY, SOMEWHERE REACHABLE ─────────────────────────────────────────────────────────────
    // This used to be log-only, so an outsider — including us, without a Stripe key — saw a bare
    // "Could not start checkout." and nothing else. The customer still gets the plain sentence; the
    // reason goes into the response for the authenticated admin who triggered it, and into an audit
    // row so the NEXT occurrence is diagnosable after the fact rather than in the moment.
    const detail = String(e?.message ?? 'unknown error').slice(0, 300);
    const stripeCode = e?.code ?? e?.type ?? null;
    const requestId = e?.requestId ?? e?.raw?.request_id ?? null;   // the id Stripe support asks for
    console.error('[stripe] checkout error', { detail, stripeCode, requestId, groupId });
    await writeAudit(prisma as any, {
      groupId, userId: vis.userId ?? null,
      action: 'checkout.failed', entity: 'group', entityId: groupId,
      diff: { detail, stripeCode, requestId, quantity, currency: wantCurrency },
    }).catch(() => { /* never let the audit write mask the original failure */ });
    return res.status(502).json({ message: 'Could not start checkout.', code: stripeCode, detail, requestId });
  }
}
