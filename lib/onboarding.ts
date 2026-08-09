/**
 * File: lib/onboarding.ts
 * THE onboarding completion chokepoint (item-13). ONE source of "is this tenant set up?" — derived
 * truth, never a stored onboarding_step flag (derived state can't drift; same discipline as the
 * outbox keying off snapshot existence). Read by the root gate on every admin request AND by the
 * wizard pages to self-sequence.
 *
 * Completion (ordered; the gate SHORT-CIRCUITS at the first miss — an incomplete-at-site tenant
 * costs ONE indexed query):
 *   (A) country       — a supported country is chosen
 *   (B) phone         — the signed-in ADMIN has confirmed a mobile. GB ONLY, and per-USER: see
 *                       OnboardingActor and the warning at the check itself
 *   (C) site          — the tenant has at least one Site
 *   (D) rates         — that Site has default_labour_rate (nullable, no default → genuine signal)
 *   (E) tax           — Group.tax_default_rate_bp is set (Int?, NULL until the tax step writes it)
 *   (F) subscription  — GroupBilling.subscription_status ∈ {trialing, active, past_due}
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

// The wizard's SHAPE lives in lib/onboarding-order — no Prisma, so the browser can read it too and
// the step counter cannot drift from the gate. Re-exported here: every existing caller imports these
// from lib/onboarding and there is no reason to churn them.
export { ONBOARDING_ORDER, stepPath, stepLabel, stepNumber, STEP_COUNT } from '@/lib/onboarding-order';
export type { OnboardingStep } from '@/lib/onboarding-order';
import type { OnboardingStep } from '@/lib/onboarding-order';

/**
 * ── GROUPS CREATED BEFORE THIS ARE NOT ASKED ────────────────────────────────────────────────────
 * The phone step is a signup requirement, not a retrospective one. Without a cutoff, shipping it
 * would have locked every existing tenant out of their dashboard on deploy morning — five of five
 * were unverified when this was written, including the live paying garage.
 *
 * A DATE rather than a per-tenant flag: it needs no backfill, no marker to go stale, and it answers
 * "was this tenant asked at signup?" exactly, for ever. Tenants before it are never asked; tenants
 * after it always are.
 *
 * ── MOVED TO TODAY, 2026-08-09 (ruling) ─────────────────────────────────────────────────────────
 * It shipped at 2026-08-10 so that nothing live could be caught while the step was still being
 * proved. It is now today's date, so a signup today meets the step — which is the point. That is a
 * REAL boundary, not a test one: it caught one existing tenant (BigDog, created 14:18 today), whose
 * admin now stands behind the step until they confirm a number or an operator exempts them.
 *
 * MOVING THIS DATE BACKWARDS IS A LOCKOUT. Every admin of every GB tenant created after it who has
 * no recorded number is held at the step the moment they next load a page — no warning, no email,
 * nothing they did. Measure before touching it: scripts/phone-gate-blast-radius.mjs names them.
 */
export const PHONE_STEP_REQUIRED_FROM = new Date('2026-08-09T00:00:00.000Z');

/** The ONE country the phone step runs for. See the warning at the check — widening this is a
 *  deliberate act, and it is the thing a second country's rollout must not forget. */
export const PHONE_STEP_COUNTRY = 'GB';

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
 * Each check is a single indexed lookup.
 */
export async function getOnboardingState(
  groupId: string | null | undefined,
  actor?: OnboardingActor,
): Promise<OnboardingState> {
  if (!groupId) return { onboarded: false, firstIncompleteStep: 'country' };

  // (A) COUNTRY FIRST — a SUPPORTED country must be chosen. An unsupported one leaves country_code
  // set but not supported: the tenant stays on the country step, which renders the coming-soon gate.
  const grpCountry = (await prisma.group.findUnique({
    where: { id: groupId }, select: { country_code: true },
  })) as { country_code: string | null } | null;
  if (!isSupportedCountry(grpCountry?.country_code)) return { onboarded: false, firstIncompleteStep: 'country' };

  // (B) THE PHONE — after country, and the only per-USER step.
  //
  // ── IT RUNS FOR GB ONLY ──────────────────────────────────────────────────────────────────────
  // It briefly ran FIRST, ahead of country, and that was wrong in a way worth recording: with no
  // country chosen there is no dial code, so toE164Digits fell back to '44' and a non-GB number was
  // parsed as British — and the visitor confirmed a number before we told them we are not open
  // where they are. Sitting here, country_code is known AND supported, so pages/api/account/phone's
  // dialCodeFor reads a real value instead of a default.
  //
  // ⚠ THE SKIP IS SILENT, AND IT WILL NEED DOING RATHER THAN HAPPENING. The day a second country
  // opens, this line switches the phone step OFF for it — no error, no warning, just a step that
  // never appears, and admins there will hold no recovery number at all. That is the safer of the
  // two failure directions (the alternative is misparsing real numbers against the GB dial code),
  // but it is a decision deferred, not a decision made: whoever enables country number two must
  // come here, widen this test, and give lib/contact-routes a dial code for it.
  //
  // Three ways to be complete, and only the first proves a handset:
  //   • phone_recorded_at — a code was confirmed, by SMS or by the email fallback
  //   • the tenant is EXEMPT — an operator granted a break-glass (lib/onboarding does not care why)
  //   • the group predates PHONE_STEP_REQUIRED_FROM — never asked at signup, never asked now
  if (actor?.userId && grpCountry?.country_code?.toUpperCase() === PHONE_STEP_COUNTRY) {
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

  // (C) — the tenant has a site.
  const site = (await prisma.site.findFirst({
    where: { group_id: groupId },
    select: { id: true },
  })) as { id: string } | null;
  if (!site) return { onboarded: false, firstIncompleteStep: 'site' };

  // (D) — the rates step wrote the LABOUR_HR service with a labour rate. That row (not a Site column)
  // is where the labour rate lives; its existence with a non-null rate is the "rates done" signal.
  const labour = (await prisma.serviceCatalogue.findFirst({
    where: { group_id: groupId, service_code: 'LABOUR_HR', default_labour_rate: { not: null } },
    select: { id: true },
  })) as { id: string } | null;
  if (!labour) return { onboarded: false, firstIncompleteStep: 'rates' };

  // (E) — tax profile answered.
  const group = (await prisma.group.findUnique({
    where: { id: groupId },
    select: { tax_default_rate_bp: true },
  })) as { tax_default_rate_bp: number | null } | null;
  if (group?.tax_default_rate_bp == null) return { onboarded: false, firstIncompleteStep: 'tax' };

  // (F) — a real Stripe trial/subscription exists (webhook- or confirm-written mirror).
  const billing = (await prisma.groupBilling.findUnique({
    where: { group_id: groupId },
    select: { subscription_status: true },
  })) as { subscription_status: string | null } | null;
  if (!billing || !SUBSCRIBED.has(billing.subscription_status ?? '')) {
    return { onboarded: false, firstIncompleteStep: 'checkout' };
  }

  return { onboarded: true, firstIncompleteStep: null };
}
