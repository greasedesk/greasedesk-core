/**
 * File: pages/index.tsx
 * Public homepage. Built on the APP's semantic design system (gd* palette retired) so the marketing
 * site and the product read as one thing. Hero centres on the "see your real profit" P&L insight;
 * the P&L screenshot slot is a LABELLED PLACEHOLDER — real demo data fills it (no fabricated image).
 */
import Link from 'next/link';
import Seo from '@/components/marketing/Seo';
import SiteChrome from '@/components/marketing/SiteChrome';
import { perLocationLabel } from '@/lib/billing-pricing';

const Check = () => (
  <svg className="w-5 h-5 text-accent shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
  </svg>
);

const FEATURES = [
  { title: 'See your real profit', body: 'A live profit-and-loss view — revenue, true parts cost, labour and overheads — so you know what each month actually made, not just what you billed.' },
  { title: 'Digital job cards', body: 'Create, price and track every job from one screen, with photos, a full audit trail and freeze-at-issue invoicing you can trust.' },
  { title: 'Multi-site ready', body: 'Run one bay or several from a single login — bookings, staff and figures scoped per location, consolidated when you want the whole picture.' },
];

export default function HomePage() {
  return (
    <>
      <Seo
        title="GreaseDesk — Garage management software that shows your real profit"
        description="Job cards, bookings, invoicing and a live profit-and-loss view for independent garages. Start a 60-day free trial — £75 per site, per month."
        path="/"
        softwareApp
      />
      <SiteChrome>
        {/* Hero — two column: copy + CTAs left, P&L screenshot placeholder right */}
        <section className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 pt-16 sm:pt-24 pb-16">
          <div className="grid lg:grid-cols-2 gap-12 lg:gap-16 items-center">
            <div>
              <h1 className="text-4xl sm:text-5xl font-extrabold text-ink tracking-tight leading-tight">
                See your <span className="text-accent">real profit</span>, not just your takings.
              </h1>
              <p className="mt-6 text-lg text-muted max-w-xl">
                GreaseDesk runs your job cards, bookings and invoicing — then shows you a live profit-and-loss
                view built on true parts cost, so you know what each month actually made.
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
          <h2 className="text-2xl sm:text-3xl font-bold text-ink text-center">Everything a workshop needs — in one place</h2>
          <div className="mt-10 grid grid-cols-1 md:grid-cols-3 gap-6">
            {FEATURES.map((f) => (
              <div key={f.title} className="bg-surface border border-line rounded-2xl p-6 shadow-card">
                <Check />
                <h3 className="mt-4 text-lg font-semibold text-ink">{f.title}</h3>
                <p className="mt-2 text-sm text-muted">{f.body}</p>
              </div>
            ))}
          </div>
          <div className="mt-12 text-center">
            <Link href="/register" className="inline-block bg-accent hover:bg-accent-hover text-white font-semibold rounded-lg px-6 py-3.5 text-base transition-colors">
              Start your 60-day free trial
            </Link>
          </div>
        </section>
      </SiteChrome>
    </>
  );
}
