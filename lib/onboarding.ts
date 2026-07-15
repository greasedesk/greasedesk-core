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
 *   (D) subscription  — GroupBilling.subscription_status ∈ {trialing, active}
 *                       (webhook/confirm-written mirror of Stripe's truth; a real trial/sub exists)
 *
 * None of these columns carry a value until its step runs, so "done" is inferred from data alone.
 * (C) shares the column the banked rate-bp backfill fills — running that backfill marks EXISTING
 * tenants tax-complete, which is correct; new tenants start NULL and the wizard fills it.
 */
import { prisma } from '@/lib/db';

export type OnboardingStep = 'site' | 'rates' | 'tax' | 'checkout';

/** The wizard order — also the order the gate evaluates completion in. */
export const ONBOARDING_ORDER: OnboardingStep[] = ['site', 'rates', 'tax', 'checkout'];

/** A live trial or paid subscription — the only statuses that count as "billing done". */
const SUBSCRIBED = new Set(['trialing', 'active']);

/** The wizard page each step lives on (single place the step→URL mapping is defined). */
export function stepPath(step: OnboardingStep): string {
  switch (step) {
    case 'site': return '/onboarding/setup';
    case 'rates': return '/onboarding/rates-settings';
    case 'tax': return '/onboarding/tax';
    case 'checkout': return '/onboarding/billing';
  }
}

export type OnboardingState = {
  onboarded: boolean;
  firstIncompleteStep: OnboardingStep | null;
};

/**
 * Derive completion for a group, short-circuiting at the first incomplete step.
 * Each check is a single indexed lookup; (A)+(B) share one Site read.
 */
export async function getOnboardingState(groupId: string | null | undefined): Promise<OnboardingState> {
  if (!groupId) return { onboarded: false, firstIncompleteStep: 'site' };

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
