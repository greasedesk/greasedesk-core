/**
 * File: lib/stripe-account-session.ts
 * THE Account Session mint — the short-lived token that lets Stripe's embedded components render a
 * garage's own payments, payouts and account details inside a GreaseDesk page.
 *
 * ── THE SESSION IS THE PERMISSION. HIDING A BUTTON IS NOT. ──────────────────────────────────────
 * Stripe grants capability per component and per feature at session creation, server side. A session
 * minted with `refund_management` lets the holder issue refunds whatever our UI chooses to render —
 * so access is decided HERE, from the signed-in user's role, and never from anything the client
 * sends. Stripe's own guidance is to map site roles onto session components, and this is that map.
 * Widening it later is a change to one table below; leaking is not recoverable.
 *
 * ── WHY SOME PANELS MAKE STRIPE ASK THE GARAGE TO SIGN IN ───────────────────────────────────────
 * Authentication is required for connected accounts where STRIPE collects updated information when
 * requirements change. Standard accounts are exactly those, so Account management, Balances, Payouts
 * and the Notification banner can pop a Stripe sign-in, and Stripe is explicit that the popup cannot
 * be styled or suppressed. The escape hatch — the `disable_stripe_user_authentication` feature — is
 * only offered on configurations where WE collect requirements, and taking it means assuming
 * liability for connected accounts that cannot repay a negative balance: precisely the exposure the
 * Standard ruling of 2026-08-13 exists to avoid. So it is not available to us, and we should not
 * want it.
 *
 * The consequence is a real product choice, made deliberately: PAYOUTS_LIST rather than PAYOUTS.
 * The list answers "have I been paid, and when" with no sign-in; the payouts component adds the
 * ability to trigger one, and authenticates. A garage owner checking their money should not have to
 * log in to a second product to do it.
 */
import type Stripe from 'stripe';
import { getStripe } from '@/lib/stripe';

/**
 * What this user may do with the garage's payment provider.
 *   'full'      manage money: refunds, disputes, capture, and the account's own details
 *   'read_only' see payments and payouts, change nothing
 *   'none'      no session is minted at all
 *
 * Only 'full' is reachable today — /admin/payments is admin-only, matching HR. 'read_only' is
 * defined because the widening question WILL be asked (a `can_invoice` mechanic wanting to see
 * whether an invoice was paid), and the answer should be a role mapping that already exists rather
 * than a hurried edit to a live components block.
 */
export type PaymentsAccess = 'full' | 'read_only' | 'none';

/**
 * THE role map, as a pure function so it can be asserted without Stripe, a tenant, or a network.
 * `isAdmin` is getVisibility's — ADMIN or owner; a SITE_MANAGER is deliberately NOT an admin here,
 * the same line HR draws, because payouts and bank details are owner-grade.
 */
export function paymentsAccessFor(vis: { isAdmin?: boolean } | null | undefined): PaymentsAccess {
  return vis?.isAdmin ? 'full' : 'none';
}

/**
 * The components block for a level of access. Exported so a gate can assert that a non-admin gets
 * nothing and a read-only session cannot refund — against the real map, not a copy of it.
 *
 * Returns null when no session should exist. That is not the same as an empty components block:
 * Stripe would happily mint a session granting nothing, and a token that exists is a token that can
 * be widened by a later bug.
 */
export function sessionComponentsFor(access: PaymentsAccess): Record<string, any> | null {
  if (access === 'none') return null;
  const full = access === 'full';
  return {
    // Payments and payment details do not authenticate. The features are what turn a list into a
    // set of powers, so they are named explicitly rather than left to Stripe's defaults — every one
    // of them defaults to TRUE, and a read-only session inheriting those defaults would be a
    // read-only session that can issue refunds.
    payments: {
      enabled: true,
      features: {
        refund_management: full,
        dispute_management: full,
        capture_payments: full,
        destination_on_behalf_of_charge_management: false,
      },
    },
    payment_details: {
      enabled: true,
      features: {
        refund_management: full,
        dispute_management: full,
        capture_payments: full,
        destination_on_behalf_of_charge_management: false,
      },
    },
    // The read-only history of money reaching the bank. No features, and no sign-in.
    payouts_list: { enabled: true },
    // Changing bank or business details is Stripe's to authorise and only an admin sees it.
    // external_account_collection stays TRUE: switching it off would leave a garage unable to
    // change the bank account their money lands in without leaving GreaseDesk entirely, which is
    // the whole thing this page exists to prevent.
    ...(full
      ? { account_management: { enabled: true, features: { external_account_collection: true } } }
      : {}),
  };
}

/**
 * Mint the session. Throws with a `CONNECT:` prefix for conditions the caller should translate into
 * a sentence, rather than leaking Stripe's wording to a garage owner.
 */
export async function createAccountSession(accountId: string, access: PaymentsAccess): Promise<{ clientSecret: string; expiresAt: number }> {
  const stripe = getStripe();
  if (!stripe) throw new Error('CONNECT:not_configured');
  const components = sessionComponentsFor(access);
  if (!components) throw new Error('CONNECT:not_permitted');

  const session = (await stripe.accountSessions.create({
    account: accountId,
    components,
  } as any)) as Stripe.AccountSession;
  return { clientSecret: session.client_secret, expiresAt: session.expires_at };
}
