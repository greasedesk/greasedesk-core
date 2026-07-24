/**
 * File: pages/index.tsx
 * Public homepage. Built on the APP's semantic design system (gd* palette retired) so the marketing
 * site and the product read as one thing. Hero centres on the "see your real profit" P&L insight;
 * the P&L screenshot slot is a LABELLED PLACEHOLDER — real demo data fills it (no fabricated image).
 */
import Link from 'next/link';
import Seo from '@/components/marketing/Seo';
import SiteChrome from '@/components/marketing/SiteChrome';
import { PAGE_TITLE } from '@/lib/brand';
import { perLocationLabel } from '@/lib/billing-pricing';

const Check = () => (
  <svg className="w-5 h-5 text-accent shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
  </svg>
);

const FEATURES = [
  { title: 'Earn it', body: "Job cards, bookings, quotes and invoicing in one place. Price the work, track it, bill it, get paid — with photos and a full audit trail on every job." },
  { title: 'See it', body: "A live profit-and-loss view built on true parts cost. The hours you sold against the hours you paid for. The numbers a diary can't show you." },
  { title: 'Keep it', body: "Know which jobs, which customers and which months made money, and which quietly didn't. Then price the next ones properly." },
];

// Section 3 — contrast rows. Category-defining copy: a busy diary is not a result.
const CONTRASTS = [
  { title: "Turnover isn't profit.", body: 'Parts at true cost, against every job.' },
  { title: "Booked isn't sold.", body: 'The hours you paid for, against the hours you charged for.' },
  { title: "Invoiced isn't banked.", body: "What's issued, what's paid, what's still owed." },
];

export default function HomePage() {
  return (
    <>
      <Seo
        title={PAGE_TITLE}
        description="See what you actually kept: GreaseDesk gives independent garages a live profit-and-loss view alongside job cards, bookings and invoicing. Start a 60-day free trial."
        path="/"
        softwareApp
      />
      <SiteChrome>
        {/* Hero — two column: copy + CTAs left, P&L screenshot placeholder right */}
        <section className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 pt-16 sm:pt-24 pb-16">
          <div className="grid lg:grid-cols-2 gap-12 lg:gap-16 items-center">
            <div>
              <p className="text-xs sm:text-sm font-semibold uppercase tracking-[0.2em] text-muted">Workshop Economics</p>
              <h1 className="mt-3 text-4xl sm:text-5xl font-extrabold text-ink tracking-tight leading-tight">
                {"The numbers don't lie. "}<span className="text-accent">They hide.</span>
              </h1>
              <p className="mt-6 text-lg text-muted max-w-xl">
                GreaseDesk runs your job cards, bookings and invoicing — then shows you what the diary never
                does: true parts cost, the hours you sold against the hours you paid for, and what each month
                actually made.
              </p>
              <div className="mt-8 flex flex-col sm:flex-row gap-3">
                <Link href="/register" className="inline-flex justify-center items-center bg-accent hover:bg-accent-hover text-white font-semibold rounded-lg px-6 py-3.5 text-base transition-colors">
                  Start your 60-day free trial
                </Link>
                <Link href="/contact" className="inline-flex justify-center items-center bg-surface border border-line text-ink font-medium rounded-lg px-6 py-3.5 text-base hover:bg-surface-muted transition-colors">
                  Talk to us
                </Link>
              </div>
              <p className="mt-4 text-sm text-muted">{perLocationLabel()} per site, per month · payment card required · cancel anytime.</p>
            </div>

            {/* P&L dashboard — LABELLED PLACEHOLDER sized to the real screenshot (16:10). Demo data fills it. */}
            <div className="lg:pl-4">
              <div className="rounded-2xl border-2 border-dashed border-line bg-surface-muted aspect-[16/10] flex flex-col items-center justify-center text-center p-6 shadow-card">
                <div className="text-3xl mb-3" aria-hidden="true">📊</div>
                <div className="text-sm font-semibold text-ink">P&amp;L dashboard</div>
                <div className="mt-1 text-xs text-muted">Live product screenshot — demo data coming</div>
              </div>
            </div>
          </div>
        </section>

        {/* Features */}
        <section id="features" className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-8 scroll-mt-20">
          <h2 className="text-2xl sm:text-3xl font-bold text-ink text-center">Earn it. See it. Keep it.</h2>
          <div className="mt-10 grid grid-cols-1 md:grid-cols-3 gap-6">
            {FEATURES.map((f) => (
              <div key={f.title} className="bg-surface border border-line rounded-2xl p-6 shadow-card">
                <Check />
                <h3 className="mt-4 text-lg font-semibold text-ink">{f.title}</h3>
                <p className="mt-2 text-sm text-muted">{f.body}</p>
              </div>
            ))}
          </div>
        </section>

        {/* Contrast — the category argument. Visually lighter than the cards: plain rows, no borders. */}
        <section className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-16">
          <h2 className="text-2xl sm:text-3xl font-bold text-ink text-center">A full diary is not a result.</h2>
          <p className="mt-3 text-lg text-muted text-center max-w-2xl mx-auto">
            Every garage system will show you a busy week. Almost none will tell you whether it paid.
          </p>
          <div className="mt-10 max-w-2xl mx-auto flex flex-col gap-6">
            {CONTRASTS.map((c) => (
              <div key={c.title} className="flex flex-col sm:flex-row sm:items-baseline gap-1 sm:gap-4">
                <h3 className="text-lg font-semibold text-ink sm:w-56 sm:shrink-0">{c.title}</h3>
                <p className="text-base text-muted">{c.body}</p>
              </div>
            ))}
          </div>
        </section>

        {/* Closing CTA */}
        <section className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
          <div className="text-center">
            <h2 className="text-2xl sm:text-3xl font-bold text-ink">Find out what last month actually made.</h2>
            <div className="mt-8">
              <Link href="/register" className="inline-block bg-accent hover:bg-accent-hover text-white font-semibold rounded-lg px-6 py-3.5 text-base transition-colors">
                Start your 60-day free trial
              </Link>
            </div>
          </div>
        </section>
      </SiteChrome>
    </>
  );
}
