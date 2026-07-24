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

// Amendment 1 — hero dashboard-extract tiles. STATIC marketing markup styled to read as the real
// product (app tile look copied, never imported). Figures are illustrative — the caption says so;
// on tiles 1 & 2 the comparison line uses the warn token (the posted-vs-realised gap is the point,
// it must not read as a positive).
const HERO_TILES = [
  { label: 'Effective hourly rate', figure: '£38.86', sub: 'Posted rate £75.00', warn: true },
  { label: 'Hours sold', figure: '87.25', sub: 'of 157 paid for', warn: true },
  { label: 'Gross profit', figure: '£9,327.79', sub: 'on £12,940.67 revenue', warn: false },
  { label: 'Work in progress', figure: '£4,180', sub: '9 open jobs', warn: false },
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
        {/* Amendment 3 (revised) — CONTAINED descending pyramid (no longer full-bleed): sits in the
            standard page container, matching the hero's bounds. Each line's font-size is DERIVED — its
            rendered width-per-px was measured on the page font, then solved to hit ~90/72/55% of the
            CONTAINER width, so the lines step DOWN in width. Expressed in cqw against a container-query
            wrapper, so the ratio holds across the desktop range (the container caps at max-w-6xl).
            Colour + weight descend with width: L1 darkest (ink/80) → L2 muted → L3 lightest (muted/60),
            all font-light and clearly subordinate to the extrabold H1. Tight leading — one calm block.
            Below md: fixed readable sizes (L1 one line, L2 text-base, L3 text-sm; L2-L3 may wrap).
            Non-heading <p>s — the H1 below is the page's only heading. */}
        <section className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 pt-8 pb-2 sm:pt-10 sm:pb-3">
          <div className="[container-type:inline-size] text-center">
            <p className="uppercase whitespace-nowrap leading-tight font-light text-ink opacity-80 tracking-[0.06em] md:tracking-[0.1em] text-2xl md:text-[6.83cqw]">WORKSHOP ECONOMICS</p>
            <p className="whitespace-normal md:whitespace-nowrap leading-tight font-light text-muted tracking-[0.02em] mt-1 text-base md:text-[4.01cqw]">Potential vs reality — and the opportunity.</p>
            <p className="whitespace-normal md:whitespace-nowrap leading-tight font-light text-muted opacity-60 tracking-[0.02em] mt-1 text-sm md:text-[1.36cqw]">Know what your workshop could earn and what it actually earned, so you can close the gap.</p>
          </div>
        </section>

        {/* Hero — two column: copy + CTAs left, dashboard-extract tiles right. */}
        <section className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 pt-4 sm:pt-6 pb-16">
          <div className="grid lg:grid-cols-2 gap-12 lg:gap-16 items-center">
            <div>
              <h1 className="text-4xl sm:text-5xl font-extrabold text-ink tracking-tight leading-tight">
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

            {/* Amendment 1 — dashboard-extract tile group (static marketing markup; app tile styling
                copied, not imported). 2×2 on desktop, single column below md. */}
            <div className="lg:pl-4">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {HERO_TILES.map((tile) => (
                  <div key={tile.label} className="bg-surface p-5 rounded-xl border border-line">
                    <h3 className="text-sm font-semibold text-muted mb-2">{tile.label}</h3>
                    <p className="text-3xl font-bold text-ink tabular-nums">{tile.figure}</p>
                    <p className={`text-xs mt-1 ${tile.warn ? 'text-warn' : 'text-muted'}`}>{tile.sub}</p>
                  </div>
                ))}
              </div>
              <p className="mt-3 text-xs text-muted">Example figures.</p>
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
