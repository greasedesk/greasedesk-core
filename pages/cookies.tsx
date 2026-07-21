/**
 * File: pages/cookies.tsx
 * Cookie policy page — STUB. The banner + footers link here so the links are live, and it carries the
 * FACTUAL cookie disclosure (the audited inventory). It deliberately does NOT contain the legal prose
 * (controller identity, lawful basis, rights, retention wording) — that is a separate, review-required
 * job the owner drafts. Every legal section below is marked LEGAL TODO for the owner to supply.
 */
import Seo from '@/components/marketing/Seo';
import SiteChrome from '@/components/marketing/SiteChrome';
import { POLICY_VERSION } from '@/lib/consent';

const ROWS: { name: string; purpose: string; category: string; party: string; life: string }[] = [
  { name: '__Secure-next-auth.session-token', purpose: 'Keeps you signed in (session)', category: 'Strictly necessary', party: 'First party', life: '90 days (rolling)' },
  { name: '__Host-next-auth.csrf-token', purpose: 'Protects the sign-in form (CSRF)', category: 'Strictly necessary', party: 'First party', life: 'Session' },
  { name: '__Secure-next-auth.callback-url', purpose: 'Returns you to the right page after sign-in', category: 'Strictly necessary', party: 'First party', life: 'Session' },
  { name: 'gd_consent', purpose: 'Remembers your cookie choice', category: 'Strictly necessary', party: 'First party', life: '180 days' },
  { name: 'gd_ref', purpose: 'Credits a reseller who referred you (referral attribution)', category: 'Functional', party: 'First party', life: '90 days' },
  { name: 'Cloudflare Turnstile', purpose: 'Anti-spam check on the contact & reseller forms only', category: 'Strictly necessary (security)', party: 'Third party (Cloudflare)', life: 'Short-lived' },
  { name: 'Stripe (checkout.stripe.com)', purpose: 'Payment/fraud on Stripe’s hosted checkout — only if you subscribe', category: 'Strictly necessary (payment)', party: 'Third party (Stripe)', life: 'Stripe-set' },
];

export default function CookiePolicyPage() {
  return (
    <SiteChrome>
      <Seo title="Cookie policy" description="How GreaseDesk uses cookies." path="/cookies" />
      <main className="max-w-3xl mx-auto px-4 sm:px-6 py-12">
        <h1 className="text-3xl font-extrabold text-ink tracking-tight">Cookie policy</h1>
        <div className="mt-3 rounded-lg border border-amber-300 bg-amber-50 text-amber-900 text-sm px-3 py-2">
          Draft — legal wording pending review. The cookie table below is factual and current; the surrounding
          legal sections are placeholders for GreaseDesk to complete.
        </div>
        <p className="mt-4 text-sm text-muted">Policy version <span className="font-mono">{POLICY_VERSION}</span>.</p>

        {/* LEGAL TODO (owner to supply): who the data controller is (GreaseDesk Ltd, address, ICO reg no.),
            the lawful basis for functional cookies (consent), how to withdraw/change consent, data-subject
            rights, and a contact for cookie queries. Do not ship this page publicly until this is written. */}
        <section className="mt-6">
          <h2 className="text-lg font-semibold text-ink">What we use</h2>
          <p className="text-sm text-muted mt-1">
            We run strictly-necessary cookies to keep the site working, one optional functional cookie
            (referral attribution), and — today — <strong>no analytics or advertising cookies</strong>. You choose
            the optional categories in the banner, and can change your mind any time via “Cookie settings”.
          </p>
        </section>

        <div className="mt-4 overflow-x-auto rounded-xl border border-line">
          <table className="w-full text-sm">
            <thead className="bg-surface-muted text-muted text-left">
              <tr>{['Cookie', 'Purpose', 'Category', 'Party', 'Lifespan'].map((h) => <th key={h} className="px-3 py-2 font-medium whitespace-nowrap">{h}</th>)}</tr>
            </thead>
            <tbody>
              {ROWS.map((r) => (
                <tr key={r.name} className="border-t border-line">
                  <td className="px-3 py-2 font-mono text-xs text-ink whitespace-nowrap">{r.name}</td>
                  <td className="px-3 py-2 text-muted">{r.purpose}</td>
                  <td className="px-3 py-2 text-muted whitespace-nowrap">{r.category}</td>
                  <td className="px-3 py-2 text-muted whitespace-nowrap">{r.party}</td>
                  <td className="px-3 py-2 text-muted whitespace-nowrap">{r.life}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* LEGAL TODO (owner to supply): third-party processor detail + links to Cloudflare & Stripe policies,
            international-transfer wording, retention specifics, and the review/last-updated date. */}
        <p className="mt-6 text-xs text-muted">This disclosure is generated from the platform’s audited cookie inventory. Legal review pending.</p>
      </main>
    </SiteChrome>
  );
}
