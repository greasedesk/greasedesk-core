/**
 * File: lib/stripe-connect.ts
 * THE chokepoint for a garage's own Stripe account — creation, the onboarding link, the state the
 * product reads, and the sentence it says. Nothing here takes a payment; that is a later slice.
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
 * pricing conversation, not a risk.
 *
 * ── STATE IS A CACHE OF STRIPE'S TRUTH, NEVER A LOCAL CLAIM ─────────────────────────────────────
 * charges_enabled / payouts_enabled / disabled_reason / requirements are Stripe's, mirrored here by
 * webhook so the product can render without a round trip. `stripe_disabled_reason` is stored
 * VERBATIM: paraphrasing is how a product ends up telling a garage something Stripe's own dashboard
 * contradicts. When the two disagree, Stripe is right and the fix is to re-sync, never to edit.
 */
import type Stripe from 'stripe';
import { prisma } from '@/lib/db';
import { getStripe, appBaseUrl, platformLivemode } from '@/lib/stripe';
import { isDemoGroup } from '@/lib/demo-tenant';

/** Countries where a garage may connect. GB only, the same admission rule the product already has. */
const CONNECT_COUNTRIES = new Set(['GB']);

export type ConnectState =
  /** No account has ever been created for this tenant. */
  | { status: 'not_connected' }
  /** Created, but the garage has not finished Stripe's onboarding. */
  | { status: 'incomplete'; accountId: string; requirementsDue: string[] }
  /** Onboarded and able to take payments. */
  | { status: 'ready'; accountId: string; payoutsEnabled: boolean }
  /** Stripe has switched charges off — the reason is Stripe's own wording. */
  | { status: 'restricted'; accountId: string; reason: string | null; requirementsDue: string[] }
  /** The garage revoked our access from their Stripe dashboard. */
  | { status: 'disconnected'; disconnectedAt: Date }
  /**
   * The stored account cannot be read with this environment's key. Overwhelmingly this means a
   * MODE MISMATCH — an account created in a sandbox being read by the live deployment, or the
   * reverse — which Stripe reports as a bare "no such account" that means nothing to a garage.
   */
  | { status: 'unreachable'; accountId: string; accountLivemode: boolean | null; reason: string };

type GroupConnect = {
  stripe_account_id: string | null;
  stripe_charges_enabled: boolean;
  stripe_payouts_enabled: boolean;
  stripe_disabled_reason: string | null;
  stripe_requirements_due: unknown;
  stripe_disconnected_at: Date | null;
};

const dueList = (v: unknown): string[] => (Array.isArray(v) ? (v as string[]) : []);

/**
 * The one place that turns stored columns into a state the UI can switch on. Derived, never stored:
 * a `connection_status` column would be a fifth thing to keep in step with Stripe and the first to
 * go stale.
 */
export function connectState(g: GroupConnect | null | undefined): ConnectState {
  if (!g?.stripe_account_id) {
    return g?.stripe_disconnected_at ? { status: 'disconnected', disconnectedAt: g.stripe_disconnected_at } : { status: 'not_connected' };
  }
  const due = dueList(g.stripe_requirements_due);
  if (g.stripe_charges_enabled) return { status: 'ready', accountId: g.stripe_account_id, payoutsEnabled: g.stripe_payouts_enabled };
  // Charges off WITH a reason from Stripe is a restriction; charges off with no reason is simply an
  // onboarding that was started and not finished. Different sentences, different remedies.
  if (g.stripe_disabled_reason) {
    return { status: 'restricted', accountId: g.stripe_account_id, reason: g.stripe_disabled_reason, requirementsDue: due };
  }
  return { status: 'incomplete', accountId: g.stripe_account_id, requirementsDue: due };
}

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
    select: {
      stripe_account_id: true, group_name: true, company_number: true, country_code: true,
      billing_email: true, phone: true, address: true, vat_number: true,
    },
  })) as any;
  if (!g) throw new Error('CONNECT:group_not_found');

  let accountId: string | undefined = g.stripe_account_id ?? undefined;
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
    await prisma.group.update({
      where: { id: args.groupId },
      // connected_at is stamped at CREATION, not at completion — it is when the account came into
      // existence. Whether it can trade is charges_enabled's job and nothing else's.
      // The ACCOUNT object carries no livemode — inconveniently, since it is the one object where
      // mode matters most. lib/stripe::platformLivemode asks Stripe (via Balance, which does carry
      // it) and caches the answer for the process. NULL if it could not be determined: unknown,
      // never a guess.
      data: {
        stripe_account_id: accountId, stripe_account_livemode: await platformLivemode(),
        stripe_connected_at: new Date(), stripe_disconnected_at: null,
      },
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
export async function syncAccount(groupId: string, accountId: string): Promise<ConnectState> {
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
      const g = (await prisma.group.findUnique({ where: { id: groupId }, select: { stripe_account_livemode: true } })) as any;
      const mode = g?.stripe_account_livemode;
      return {
        status: 'unreachable',
        accountId,
        accountLivemode: mode ?? null,
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
export async function applyAccount(groupId: string, acct: Stripe.Account, livemode?: boolean | null): Promise<ConnectState> {
  const due = acct.requirements?.currently_due ?? [];
  // The webhook knows the mode for free — the EVENT carries livemode even though the account does
  // not — so it passes it in. A direct sync has to ask. Either way it is recorded, never inferred.
  const mode = livemode === undefined ? await platformLivemode() : livemode;
  const g = (await prisma.group.update({
    where: { id: groupId },
    data: {
      ...(mode === null ? {} : { stripe_account_livemode: mode }),
      stripe_charges_enabled: !!acct.charges_enabled,
      stripe_payouts_enabled: !!acct.payouts_enabled,
      stripe_disabled_reason: acct.requirements?.disabled_reason ?? null,
      stripe_requirements_due: due as any,
    },
    select: {
      stripe_account_id: true, stripe_charges_enabled: true, stripe_payouts_enabled: true,
      stripe_disabled_reason: true, stripe_requirements_due: true, stripe_disconnected_at: true,
    },
  })) as any;
  return connectState(g);
}

/**
 * The garage revoked us from their own Stripe dashboard. The account id is CLEARED — it is no longer
 * ours to use — but `stripe_disconnected_at` is kept so the product can say what happened instead of
 * silently reverting to "never connected", which is a different and misleading state.
 */
export async function markDisconnected(accountId: string): Promise<void> {
  await prisma.group.updateMany({
    where: { stripe_account_id: accountId },
    data: {
      stripe_account_id: null,
      stripe_charges_enabled: false,
      stripe_payouts_enabled: false,
      stripe_disabled_reason: null,
      stripe_requirements_due: undefined,
      stripe_disconnected_at: new Date(),
    },
  });
}
