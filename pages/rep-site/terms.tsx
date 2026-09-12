/**
 * File: pages/rep-site/terms.tsx
 * RESELLER TERMS — its own page, indexable, on the reseller site's host.
 *
 * ── A FILE ROUTE, NOT THE CONTENT SYSTEM (owner, 2026-09-12), AND WHAT THAT COSTS ───────────────
 * /terms on the apex is a Content-system document rendered by pages/[slug].tsx, publishable from the
 * Engine Room with no deploy. That is the better mechanism and it is NOT used here, deliberately:
 * admitting [slug] to this host's allow-list would expose EVERY published document on it, including
 * the garage-facing privacy policy, and scoping documents by audience is a larger change than this
 * slice. So the trade, stated plainly: **reseller terms lose no-deploy publishing** — changing them
 * needs a commit and a deploy. The Content-system route stays open as a later decision; when a
 * document gains an audience or host axis, this file should become a document.
 *
 * The prose is PLACEHOLDER. Terms are the owner's and a solicitor's; nothing here invents an
 * obligation, a commission figure, a notice period or a termination right.
 */
import Seo from '@/components/marketing/Seo';
import RepSiteChrome from '@/components/rep-site/RepSiteChrome';
import { COMPANY, REP_SITE_URL, absoluteRepSiteUrl } from '@/lib/company-info';

const SECTIONS: { heading: string; body: string }[] = [
  { heading: '1. Who these terms are between', body: `PLACEHOLDER — ${COMPANY.legalName} and the reseller. The owner writes this.` },
  { heading: '2. What a reseller does', body: 'PLACEHOLDER — introductions, onboarding and first-line support. The owner writes this.' },
  { heading: '3. What a reseller is paid, and when', body: 'PLACEHOLDER — no figure and no schedule is published yet. The owner writes this.' },
  { heading: '4. Self-employment and invoicing', body: 'PLACEHOLDER — a reseller is self-employed and invoices GreaseDesk. The owner writes this.' },
  { heading: '5. Data protection', body: 'PLACEHOLDER — what a reseller may hold about a garage, and for how long. The owner writes this.' },
  { heading: '6. Ending the arrangement', body: 'PLACEHOLDER — notice, and what happens to introduced garages. The owner writes this.' },
];

export default function ResellerTerms() {
  return (
    <>
      <Seo
        title="Reseller terms — GreaseDesk"
        description="The terms between GreaseDesk and its resellers."
        path="/rep-site/terms"
        origin={REP_SITE_URL}
        ogImage={absoluteRepSiteUrl('/rep-site/og.png')}
      />
      <RepSiteChrome>
        <article className="max-w-3xl mx-auto px-4 sm:px-6 pt-10 sm:pt-16 pb-12">
          <h1 className="text-3xl sm:text-4xl font-extrabold text-ink tracking-tight">Reseller terms</h1>
          <p className="mt-3 text-sm text-muted">
            PLACEHOLDER — these terms are not final. They are published here so the page and its URL exist;
            the wording is the owner’s.
          </p>
          <div className="mt-8 space-y-8">
            {SECTIONS.map((s) => (
              <section key={s.heading}>
                <h2 className="text-lg font-semibold text-ink">{s.heading}</h2>
                <p className="mt-2 text-sm text-ink">{s.body}</p>
              </section>
            ))}
          </div>
          <p className="mt-10 text-xs text-muted">
            {COMPANY.legalName}, company number {COMPANY.companyNumber}. Registered office {COMPANY.office.line1}, {COMPANY.office.locality}, {COMPANY.office.postcode}.
          </p>
        </article>
      </RepSiteChrome>
    </>
  );
}
