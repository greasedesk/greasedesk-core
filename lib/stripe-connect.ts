/**
 * File: lib/stripe-connect.ts
 * THE chokepoint for a garage's own Stripe account — creation, the onboarding link, and the
 * translation of Stripe's account object into the provider-agnostic columns the product reads.
 *
 * ── THIS FILE NO LONGER OWNS STATE OR STORAGE ───────────────────────────────────────────────────
 * It used to derive `connectState` from eight `stripe_*` columns on Group. Both moved to
 * lib/provider-connection, because none of it was Stripe-specific and Payment Assist and Bumper are
 * next. What is left here is the only genuinely Stripe-shaped work: talking to Stripe's API and
 * turning what comes back into a row.
 *
 * ── STANDARD, NOT EXPRESS (ruling 2026-08-13) ───────────────────────────────────────────────────
 * The garage holds the Stripe relationship, gets the full Stripe Dashboard, and carries its own
 * losses. Stripe covers unrecoverable negative balances (`controller.losses.payments: stripe`).
 * The Express-equivalent configuration forces `losses.payments: application`, which would put every
 * connected garage's unrecoverable chargebacks onto GreaseDesk — an open-ended liability against a
 * £75/month product that no application-fee percentage repairs.
 *
 * What that costs us, recorded so nobody re-opens it by accident: the garage pays Stripe's
 * processing fees directly (`fees.payer: account` is forced by the full dashboard), so our
 * application fee will be a visible SECOND deduction rather than one blended figure. That is a
 * pricing conversation, not a risk. It also means Stripe collects this account's requirements, which
 * is what makes `disable_stripe_user_authentication` unavailable to us — see lib/stripe-account-session.
 *
 * ── STATE IS A CACHE OF STRIPE'S TRUTH, NEVER A LOCAL CLAIM ─────────────────────────────────────
 * charges_enabled / payouts_enabled / disabled_reason / requirements are Stripe's, mirrored here by
 * webhook so the product can render without a round trip. `disabled_reason` is stored VERBATIM:
 * paraphrasing is how a product ends up telling a garage something Stripe's own dashboard
 * contradicts. When the two disagree, Stripe is right and the fix is to re-sync, never to edit.
 */
import type Stripe from 'stripe';
import { prisma } from '@/lib/db';
import { getStripe, platformLivemode } from '@/lib/stripe';
import { isDemoGroup } from '@/lib/demo-tenant';
import { readConnection, writeConnection, clearConnection, providerState, type ProviderState } from '@/lib/provider-connection';

/** Countries where a garage may connect. GB only, the same admission rule the product already has. */
const CONNECT_COUNTRIES = new Set(['GB']);

export type ConnectRefusal = { code: string; message: string };

/** Who may connect at all. Refusals are sentences, not codes, because they reach a garage owner. */
export async function refuseConnect(groupId: string, countryCode: string | null): Promise<ConnectRefusal | null> {
  // ORDER MATTERS, and the gate caught it the wrong way round. Configuration was tested first, so in
  // an environment without Stripe keys a DEMO tenant was told "not switched on for this environment"
  // — which is a fact about our deployment, not about them, and it would have been the wrong sentence
  // the moment keys existed. Identity, then admission, then environment: the first two are true
  // regardless of whether Stripe is configured at all.
  if (await isDemoGroup(groupId)) {
    return { code: 'demo_tenant', message: 'This is a demo garage, so there is nothing to connect — nothing in it is real.' };
  }
  if (!CONNECT_COUNTRIES.has(String(countryCode ?? '').toUpperCase())) {
    return { code: 'country_unavailable', message: 'Card payments through GreaseDesk aren’t available in your country yet.' };
  }
  if (!getStripe()) return { code: 'not_configured', message: 'Card payments aren’t switched on for this environment yet.' };
  return null;
}

/**
 * Create the connected account if there isn't one, and return a fresh onboarding link.
 *
 * PREFILL HAPPENS ONCE, HERE, AND ONLY AT CREATION. After the first Account Link exists, Stripe
 * stops letting the platform read or write KYC — so anything we already know and don't pass now, the
 * garage retypes. Everything passed is a fact the tenant gave us, never a guess.
 */
export async function startOnboarding(args: {
  groupId: string;
  returnUrl: string;
  refreshUrl: string;
}): Promise<{ url: string; accountId: string }> {
  const stripe = getStripe();
  if (!stripe) throw new Error('CONNECT:not_configured');

  const g = (await prisma.group.findUnique({
    where: { id: args.groupId },
    select: { group_name: true, country_code: true, billing_email: true, phone: true },
  })) as any;
  if (!g) throw new Error('CONNECT:group_not_found');

  const existing = await readConnection(args.groupId, 'stripe');
  let accountId: string | undefined = existing?.external_id ?? undefined;
  if (!accountId) {
    const created = await stripe.accounts.create({
      type: 'standard',
      country: String(g.country_code ?? 'GB').toUpperCase(),
      email: g.billing_email ?? undefined,
      business_profile: {
        name: g.group_name ?? undefined,
        // A garage rarely has a website; the product description is the accepted substitute and
        // saves the garage a question it cannot answer.
        product_description: 'Vehicle servicing, repairs and MOT work',
        support_phone: g.phone ?? undefined,
      },
      metadata: { greasedesk_group_id: args.groupId },
    } as Stripe.AccountCreateParams);
    accountId = created.id;
    // connected_at is stamped at CREATION, not at completion — it is when the account came into
    // existence. Whether it can trade is charges_enabled's job and nothing else's.
    // The ACCOUNT object carries no livemode — inconveniently, since it is the one object where
    // mode matters most. lib/stripe::platformLivemode asks Stripe (via Balance, which does carry
    // it) and caches the answer for the process. NULL if it could not be determined: unknown,
    // never a guess.
    await writeConnection(args.groupId, 'stripe', {
      external_id: accountId,
      livemode: await platformLivemode(),
      connected_at: new Date(),
      disconnected_at: null,
    });
  }

  const link = await stripe.accountLinks.create({
    account: accountId,
    return_url: args.returnUrl,
    refresh_url: args.refreshUrl,
    type: 'account_onboarding',
  });
  return { url: link.url, accountId };
}

/**
 * Pull Stripe's current view of the account into our columns. Called by the webhook and by the
 * return leg of onboarding — because `return_url` only means "the flow was exited", never that
 * anything was completed, and a garage that lands back on our page expects it to be right.
 */
export async function syncAccount(groupId: string, accountId: string): Promise<ProviderState> {
  const stripe = getStripe();
  if (!stripe) throw new Error('CONNECT:not_configured');
  let acct: Stripe.Account;
  try {
    acct = await stripe.accounts.retrieve(accountId);
  } catch (e: any) {
    // ── SAY WHY, RATHER THAN PASSING ON "no such account" ────────────────────────────────────
    // A key can only see accounts in its own mode, so the single likeliest cause of a missing
    // account we created ourselves is that it belongs to the other mode. Stripe's raw error is
    // accurate and useless; the recorded livemode lets us name the actual problem.
    if (e?.type === 'StripeInvalidRequestError' || e?.statusCode === 403 || e?.statusCode === 404) {
      const row = await readConnection(groupId, 'stripe');
      const mode = row?.livemode ?? null;
      return {
        status: 'unreachable',
        externalId: accountId,
        livemode: mode,
        reason: mode === false
          ? 'This Stripe account was created in a sandbox and cannot be used by the live site. Disconnect it and set card payments up again.'
          : mode === true
            ? 'This Stripe account is a live account and cannot be read by a test environment.'
            : 'This Stripe account can’t be reached with the current Stripe credentials.',
      };
    }
    throw e;
  }
  return applyAccount(groupId, acct);
}

/** Write a retrieved (or webhook-delivered) account onto the tenant. The ONE writer of these columns. */
export async function applyAccount(groupId: string, acct: Stripe.Account, livemode?: boolean | null): Promise<ProviderState> {
  const due = acct.requirements?.currently_due ?? [];
  // The webhook knows the mode for free — the EVENT carries livemode even though the account does
  // not — so it passes it in. A direct sync has to ask. Either way it is recorded, never inferred.
  const mode = livemode === undefined ? await platformLivemode() : livemode;
  const row = await writeConnection(groupId, 'stripe', {
    ...(mode === null ? {} : { livemode: mode }),
    external_id: acct.id,
    charges_enabled: !!acct.charges_enabled,
    payouts_enabled: !!acct.payouts_enabled,
    disabled_reason: acct.requirements?.disabled_reason ?? null,
    requirements_due: due as any,
  });
  return providerState(row);
}

/**
 * The garage revoked us from their own Stripe dashboard. Storage keeps the record of what happened;
 * see lib/provider-connection::clearConnection for why the id goes and the timestamp stays.
 */
export async function markDisconnected(accountId: string): Promise<void> {
  await clearConnection('stripe', accountId);
}

/** Resolve the tenant that owns a connected account. Used by the webhook, which arrives naming Stripe's id. */
export async function groupForAccount(accountId: string): Promise<string | null> {
  const row = (await (prisma as any).providerConnection.findFirst({
    where: { provider: 'stripe', external_id: accountId },
    select: { group_id: true },
  })) as { group_id: string } | null;
  return row?.group_id ?? null;
}
