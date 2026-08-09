/**
 * File: lib/onboarding-order.ts
 * The wizard's SHAPE — which steps exist, in what order, on which URL, under what name.
 *
 * ── WHY THIS IS SPLIT OUT OF lib/onboarding ─────────────────────────────────────────────────────
 * lib/onboarding imports Prisma, so anything that touches it is server-only. The wizard's step
 * counter has to render in the browser, and the alternative — a second copy of the order inside a
 * component — is exactly the drift this file exists to prevent. The numbering has already gone
 * wrong twice from hand-written labels: two pages both called themselves "Step 3", and a "Step 5 of
 * 6" survived a reorder that made it step 1. One array, read by the gate and by the chrome.
 *
 * NOTHING HERE READS THE DATABASE. Keep it that way, or the layout stops building.
 */

export type OnboardingStep = 'country' | 'phone' | 'site' | 'rates' | 'tax' | 'checkout';

/**
 * The wizard order — and the order the gate evaluates completion in.
 *
 * DOCUMENTATION *AND* DISPLAY, BUT NOT THE GATE. Nothing iterates this array to decide where a
 * tenant is sent; that is the sequence of checks inside getOnboardingState, and the two must be
 * kept in step by hand. It IS the source of the step numbers a user sees.
 */
export const ONBOARDING_ORDER: OnboardingStep[] = ['country', 'phone', 'site', 'rates', 'tax', 'checkout'];

/** The wizard page each step lives on (single place the step→URL mapping is defined). */
export function stepPath(step: OnboardingStep): string {
  switch (step) {
    case 'country': return '/onboarding/country';
    case 'phone': return '/onboarding/phone';
    case 'site': return '/onboarding/setup';
    case 'rates': return '/onboarding/rates-settings';
    case 'tax': return '/onboarding/tax';
    case 'checkout': return '/onboarding/billing';
  }
}

/** What the step is called on screen. Short — it sits beside "Step 2 of 6", not instead of a title. */
export function stepLabel(step: OnboardingStep): string {
  switch (step) {
    case 'country': return 'Your country';
    case 'phone': return 'Your mobile number';
    case 'site': return 'Your garage';
    case 'rates': return 'Rates';
    case 'tax': return 'Tax';
    case 'checkout': return 'Payment';
  }
}

/** 1-based position, for "Step N of M". Returns null for anything that is not a gate step. */
export function stepNumber(step: OnboardingStep): number | null {
  const i = ONBOARDING_ORDER.indexOf(step);
  return i === -1 ? null : i + 1;
}

export const STEP_COUNT = ONBOARDING_ORDER.length;
