/**
 * File: pages/pricing.tsx
 * Public pricing. Single-tier, flat per location. The price string comes from the billing-pricing
 * chokepoint (lib/billing-pricing) — NEVER hardcoded — so it stays in lockstep with what Checkout
 * uses and carries "+ VAT" automatically only once GreaseDesk Ltd is VAT-registered.
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

const INCLUDED = [
  'Unlimited digital job cards & photos',
  'Bookings diary & customer records',
  'Invoicing with freeze-at-issue accuracy',
  'Live profit-and-loss dashboard',
  'Multi-site ready — add locations any time',
  'Email support',
];

export default function PricingPage() {
  return (
    <>
      <Seo
        title="Pricing — GreaseDesk garage management software"
        description="Simple, flat pricing: £75 per site, per month. No tiers, no setup fees, cancel any time. Start a 60-day free trial."
        path="/pricing"
        softwareApp
      />
      <SiteChrome>
        <section className="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8 pt-16 sm:pt-24 pb-8 text-center">
          <h1 className="text-4xl sm:text-5xl font-extrabold text-ink tracking-tight">Simple, flat pricing</h1>
          <p className="mt-4 text-lg text-muted">One price per site. No tiers, no setup fees, cancel any time.</p>
        </section>

        <section className="max-w-md mx-auto px-4 sm:px-6 lg:px-8 pb-16">
          <div className="bg-surface border border-line rounded-2xl p-8 shadow-card text-center">
            <div className="flex items-baseline justify-center gap-1">
              <span className="text-5xl font-extrabold text-ink tabular-nums">{perLocationLabel()}</span>
            </div>
            <p className="mt-1 text-sm text-muted">per site, per month</p>

            <Link href="/register" className="mt-6 inline-block w-full bg-accent hover:bg-accent-hover text-white font-semibold rounded-lg px-6 py-3.5 text-base transition-colors">
              Start your 60-day free trial
            </Link>
            <p className="mt-2 text-xs text-muted">Payment card required. Cancel any time.</p>

            <ul className="mt-8 space-y-3 text-left">
              {INCLUDED.map((item) => (
                <li key={item} className="flex items-start gap-3 text-sm text-ink">
                  <Check /><span>{item}</span>
                </li>
              ))}
            </ul>
          </div>
          <p className="mt-6 text-center text-sm text-muted">
            Questions about a bigger workshop? <Link href="/contact" className="text-accent hover:underline">Talk to us</Link>.
          </p>
        </section>
      </SiteChrome>
    </>
  );
}
