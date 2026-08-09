/**
 * File: components/layout/OnboardingLayout.tsx
 * The wizard's shell — light workspace, brand mark, step counter, sign out. Nothing else.
 *
 * ── WHY NOT ONE OF THE TWO SHELLS WE ALREADY HAD ────────────────────────────────────────────────
 * AdminLayout is the signed-in product: a nav rail listing Diary, Job Cards, Invoices, HR. During
 * onboarding every one of those links is a trap — the gate bounces the user straight back here, so
 * the nav would offer nothing but dead ends.
 *
 * SiteChrome is the public site: "Sign in", "Start free trial", the marketing footer. Right for
 * check-email (genuinely pre-auth), wrong the moment somebody is signed in and halfway through
 * setting up — it invites them back out of the flow they are trying to finish.
 *
 * So: a third shell, deliberately thin. The only navigation it offers is OUT (sign out), because
 * that is the only honest destination while the gate holds everything else.
 *
 * ── IT ALSO OWNS THE STEP NUMBER ────────────────────────────────────────────────────────────────
 * Not decoration. The numbering used to live in six hand-written string literals, and it went wrong
 * twice: two pages both said "Step 3", and a "Step 5 of 6" survived a reorder that had made it step
 * 1. Reading lib/onboarding-order means a reorder renumbers every screen by itself, and a page that
 * is not a gate step (team-invite) simply passes no step and gets no number.
 *
 * ── COLOUR ──────────────────────────────────────────────────────────────────────────────────────
 * Semantic tokens only. These pages were the last of the retired dark palette — they painted
 * bg-slate-900 over a body that globals.css had already set to the light workspace.
 */
import React from 'react';
import Head from 'next/head';
import { signOut } from 'next-auth/react';
import BrandLogo from '@/components/BrandLogo';
import { ONBOARDING_ORDER, STEP_COUNT, stepLabel, type OnboardingStep } from '@/lib/onboarding-order';

export default function OnboardingLayout({
  step, title, heading, intro, children, width = 'md',
}: {
  /** The gate step this page IS. Omitted for pages outside ONBOARDING_ORDER — they get no counter. */
  step?: OnboardingStep;
  /** Browser title. Defaults to the step's own label. */
  title?: string;
  /** The on-screen h1. Defaults to the step's label too, so the two cannot disagree by accident. */
  heading?: string;
  intro?: React.ReactNode;
  children: React.ReactNode;
  width?: 'md' | 'lg';
}) {
  const index = step ? ONBOARDING_ORDER.indexOf(step) : -1;
  const number = index === -1 ? null : index + 1;
  const label = step ? stepLabel(step) : null;
  const pageTitle = title ?? label ?? 'Set up your garage';

  return (
    <>
      <Head><title>{`${pageTitle} - GreaseDesk`}</title></Head>
      <div className="min-h-screen bg-content">
        <header className="border-b border-line bg-surface">
          <div className="max-w-5xl mx-auto px-4 sm:px-6 h-14 flex items-center justify-between">
            {/* href="" → no link. The default target is the dashboard, which the gate would bounce
                straight back to this page: a logo that appears to do nothing is worse than one that
                plainly isn't a link.
                plate={false}: the plate exists so the dark-navy logo reads against the DARK rail.
                On a white header it is invisible padding that stood taller than the header itself
                and hung out of the top-left corner — first at full size, then still at slim. Bounded
                by HEIGHT here, because the header is a fixed 3.5rem and the asset's aspect ratio is
                what defeated two attempts to control it by width. */}
            <BrandLogo href="" plate={false} maxHeight={40} />
            {/* SIGN OUT IS THE ONLY WAY OUT, and it is offered plainly rather than hidden. Somebody
                who has to stop halfway should not have to close the tab to do it. */}
            <button
              type="button"
              onClick={() => signOut({ callbackUrl: '/admin/login' })}
              className="text-sm text-muted hover:text-ink underline underline-offset-2"
              data-testid="onboarding-signout"
            >
              Sign out
            </button>
          </div>
        </header>

        <main className={`${width === 'lg' ? 'max-w-3xl' : 'max-w-xl'} mx-auto px-4 sm:px-6 pt-8 sm:pt-12 pb-16`}>
          {number !== null && (
            <p className="text-xs text-muted mb-2" data-testid="onboarding-step">
              Step {number} of {STEP_COUNT}
              {/* PROGRESS, not a promise of speed. No "almost there" — the tenant can count. */}
            </p>
          )}
          <div className="bg-surface border border-line rounded-2xl shadow-card p-6 sm:p-8">
            <h1 className="text-xl font-semibold text-ink mb-1">{heading ?? label ?? pageTitle}</h1>
            {intro && <div className="text-sm text-muted mb-6">{intro}</div>}
            {!intro && <div className="mb-6" />}
            {children}
          </div>
        </main>
      </div>
    </>
  );
}

/** Shared field styling, so seven pages cannot each invent their own input. Matches the sign-in
 *  screen (pages/admin/login) — the last thing the user saw before they arrived here. */
export const fieldClass =
  'w-full min-h-[48px] bg-surface border border-line rounded-lg px-3 py-2 text-base text-ink focus:outline-none focus:ring-2 focus:ring-accent';
export const labelClass = 'block text-sm font-medium text-ink mb-1 mt-4';
export const primaryButtonClass =
  'w-full min-h-[48px] bg-accent hover:bg-accent-hover text-white font-medium rounded-xl px-4 py-3 disabled:opacity-50 transition-colors';
export const helpClass = 'text-xs text-muted mt-1';
