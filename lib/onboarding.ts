/**
 * File: lib/onboarding.ts
 * THE onboarding completion chokepoint (item-13). ONE source of "is this tenant set up?" — derived
 * truth, never a stored onboarding_step flag (derived state can't drift; same discipline as the
 * outbox keying off snapshot existence). Read by the root gate on every admin request AND by the
 * wizard pages to self-sequence.
 *
 * Completion (ordered; the gate SHORT-CIRCUITS at the first miss — an incomplete-at-site tenant
 * costs ONE indexed query):
 *   (A) site          — the tenant has at least one Site
 *   (B) rates         — that Site has default_labour_rate (nullable, no default → genuine signal)
 *   (C) tax           — Group.tax_default_rate_bp is set (Int?, NULL until the tax step writes it)
 *   (D) subscription  — GroupBilling.subscription_status ∈ {trialing, active, past_due}
 *                       (webhook/confirm-written mirror of Stripe's truth; a real trial/sub exists)
 *                       past_due COUNTS AS DONE (2026-08-06): the step asks "has this tenant ever
 *                       set billing up", not "is the money currently arriving". A tenant whose card
 *                       has just failed HAS completed checkout, and bouncing them back into the
 *                       wizard would put them behind a setup screen instead of in their diary —
 *                       which is the opposite of the grace rule (full functionality for seven days).
 *                       What they may DO while past_due is lib/billing's job, not this gate's.
 *
 * None of these columns carry a value until its step runs, so "done" is inferred from data alone.
 * (C) shares the column the banked rate-bp backfill fills — running that backfill marks EXISTING
 * tenants tax-complete, which is correct; new tenants start NULL and the wizard fills it.
 */
import { prisma } from '@/lib/db';
import { isSupportedCountry } from '@/lib/locale-profiles';

export type OnboardingStep = 'country' | 'site' | 'rates' | 'tax' | 'phone' | 'checkout';

/** The wizard order — also the order the gate evaluates completion in. */
export const ONBOARDING_ORDER: OnboardingStep[] = ['country', 'site', 'rates', 'tax', 'phone', 'checkout'];

/**
 * ── GROUPS CREATED BEFORE THIS ARE NOT ASKED ────────────────────────────────────────────────────
 * The phone step is a signup requirement, not a retrospective one. Without a cutoff, shipping it
 * would have locked every existing tenant out of their dashboard on deploy morning — five of five
 * were unverified when this was written, including the live paying garage.
 *
 * A DATE rather than a per-tenant flag: it needs no backfill, no marker to go stale, and it answers
 * "was this tenant asked at signup?" exactly, for ever. Tenants before it are never asked; tenants
 * after it always are.
 */
export const PHONE_STEP_REQUIRED_FROM = new Date('2026-08-10T00:00:00.000Z');

/**
 * WHO is being gated. The other five steps are TENANT facts — a missing site is missing for
 * everybody — so they never needed this. A confirmed phone belongs to a PERSON, and a group-scoped
 * function cannot answer a per-user question: asked for the owner's phone it would redirect a
 * manager to a step they can never satisfy, and loop for ever.
 *
 * Absent, or not an admin → the phone step is treated as complete. Only the owner/admin is asked
 * (ruling), and every other step behaves exactly as it did.
 */
export type OnboardingActor = {
  userId: string;
  /**
   * OPTIONAL, and resolved lazily when absent. Callers that already hold a Visibility pass it;
   * the job-card and quote pages do not, and making them fetch one would add a query to the
   * hottest paths in the product for a step only admins ever see. It is looked up inside the phone
   * branch instead — after four short-circuits, and only for tenants the step applies to at all.
   */
  isAdmin?: boolean;
};

/** Billing has been SET UP. Not the same question as "is it paid" — see the header. A lapsed
 *  tenant is deliberately absent: they must pass back through checkout to resubscribe. */
const SUBSCRIBED = new Set(['trialing', 'active', 'past_due']);

/** The wizard page each step lives on (single place the step→URL mapping is defined). */
export function stepPath(step: OnboardingStep): string {
  switch (step) {
    case 'country': return '/onboarding/country';
    case 'site': return '/onboarding/setup';
    case 'rates': return '/onboarding/rates-settings';
    case 'tax': return '/onboarding/tax';
    case 'phone': return '/onboarding/phone';
    case 'checkout': return '/onboarding/billing';
  }
}

/** The same rule lib/site-visibility applies — an owner counts as an admin whatever their role. */
async function resolveIsAdmin(userId: string): Promise<boolean> {
  const u = (await prisma.user.findUnique({
    where: { id: userId }, select: { role: true, is_owner: true },
  })) as { role: string; is_owner: boolean } | null;
  return !!u && (u.role === 'ADMIN' || u.is_owner);
}

export type OnboardingState = {
  onboarded: boolean;
  firstIncompleteStep: OnboardingStep | null;
};

/**
 * Derive completion for a group, short-circuiting at the first incomplete step.
 * Each check is a single indexed lookup; (A)+(B) share one Site read.
 */
export async function getOnboardingState(
  groupId: string | null | undefined,
  actor?: OnboardingActor,
): Promise<OnboardingState> {
  if (!groupId) return { onboarded: false, firstIncompleteStep: 'country' };

  // (0) COUNTRY FIRST — a SUPPORTED country must be chosen. An unsupported one leaves country_code
  // set but not supported: the tenant stays on the country step, which renders the coming-soon gate.
  const grpCountry = (await prisma.group.findUnique({
    where: { id: groupId }, select: { country_code: true },
  })) as { country_code: string | null } | null;
  if (!isSupportedCountry(grpCountry?.country_code)) return { onboarded: false, firstIncompleteStep: 'country' };

  // (A) — the tenant has a site.
  const site = (await prisma.site.findFirst({
    where: { group_id: groupId },
    select: { id: true },
  })) as { id: string } | null;
  if (!site) return { onboarded: false, firstIncompleteStep: 'site' };

  // (B) — the rates step wrote the LABOUR_HR service with a labour rate. That row (not a Site column)
  // is where the labour rate lives; its existence with a non-null rate is the "rates done" signal.
  const labour = (await prisma.serviceCatalogue.findFirst({
    where: { group_id: groupId, service_code: 'LABOUR_HR', default_labour_rate: { not: null } },
    select: { id: true },
  })) as { id: string } | null;
  if (!labour) return { onboarded: false, firstIncompleteStep: 'rates' };

  // (C) — tax profile answered.
  const group = (await prisma.group.findUnique({
    where: { id: groupId },
    select: { tax_default_rate_bp: true },
  })) as { tax_default_rate_bp: number | null } | null;
  if (group?.tax_default_rate_bp == null) return { onboarded: false, firstIncompleteStep: 'tax' };

  // (C2) — THE PHONE, and the only per-USER step. Ordered before checkout deliberately: it is the
  // last thing asked before money, and a tenant who cannot complete it should discover that before
  // paying rather than after.
  //
  // Three ways to be complete, and only the first proves a handset:
  //   • phone_recorded_at — a code was confirmed, by SMS or by the email fallback
  //   • the tenant is EXEMPT — an operator granted a break-glass (lib/onboarding does not care why)
  //   • the group predates PHONE_STEP_REQUIRED_FROM — never asked at signup, never asked now
  if (actor?.userId) {
    // CHEAPEST TEST FIRST. Most tenants predate the cutoff or are exempt, and both are answered by
    // the Group row we can read without knowing anything about the user.
    const g = (await prisma.group.findUnique({
      where: { id: groupId },
      select: { created_at: true, phone_step_exempt_at: true },
    })) as { created_at: Date; phone_step_exempt_at: Date | null } | null;
    if (g && g.created_at >= PHONE_STEP_REQUIRED_FROM && !g.phone_step_exempt_at) {
      const isAdmin = actor.isAdmin ?? await resolveIsAdmin(actor.userId);
      if (isAdmin) {
        const row = (await prisma.twoFactorSecret.findUnique({
          where: { subject_type_subject_id: { subject_type: 'tenant', subject_id: actor.userId } },
          select: { phone_recorded_at: true },
        })) as { phone_recorded_at: Date | null } | null;
        if (!row?.phone_recorded_at) return { onboarded: false, firstIncompleteStep: 'phone' };
      }
    }
  }

  // (D) — a real Stripe trial/subscription exists (webhook- or confirm-written mirror).
  const billing = (await prisma.groupBilling.findUnique({
    where: { group_id: groupId },
    select: { subscription_status: true },
  })) as { subscription_status: string | null } | null;
  if (!billing || !SUBSCRIBED.has(billing.subscription_status ?? '')) {
    return { onboarded: false, firstIncompleteStep: 'checkout' };
  }

  return { onboarded: true, firstIncompleteStep: null };
}
