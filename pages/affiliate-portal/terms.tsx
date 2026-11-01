/**
 * File: pages/affiliate-portal/terms.tsx — served at /my-terms on affiliates.greasedesk.com.
 * THE AFFILIATE'S OWN COPY OF THE AGREEMENT, inside the portal, with the menu still beside it.
 *
 * ── WHY THIS PAGE EXISTS (owner, 2026-11-01) ────────────────────────────────────────────────────
 * The menu's Terms item pointed at /terms — the PUBLIC page. A signed-in affiliate clicking an item
 * in their own menu left the portal, lost the menu, and landed on the page written for somebody
 * deciding whether to join. And it answered the wrong question: a person who has already signed up
 * is asking "what did I agree to, and when", which the public page cannot know.
 *
 * ── IT SHOWS THE VERSION THEY ACCEPTED, NOT THE CURRENT ONE ─────────────────────────────────────
 * lib/affiliate-portal-terms carries that reasoning. A newer published version is NAMED, with a
 * link to the public page which always serves the latest — reported rather than substituted.
 *
 * ── NOT PUBLIC, AND noindex ─────────────────────────────────────────────────────────────────────
 * It is the same agreement, so there is nothing secret in the body; what is private is the
 * ACCEPTANCE — a date and a version against a person. requireAffiliatePage is the guard, exactly as
 * on the dashboard and the poster, and middleware keeps /affiliate-portal/* off every other host.
 */
import Head from 'next/head';
import type { GetServerSideProps } from 'next';
import { requireAffiliatePage } from '@/lib/rep-auth';
import { affiliatePortalTerms, type PortalTermsData } from '@/lib/affiliate-portal-terms';
import { termsSummary, TERMS_SUMMARY_COMING, TERMS_SUMMARY_NOTE } from '@/lib/affiliate-terms-summary';
import AffiliatePortalShell from '@/components/affiliate-portal/AffiliatePortalShell';
import PublicDocument from '@/components/content/PublicDocument';
import { COMPANY } from '@/lib/company-info';

type Props = { data: PortalTermsData };

/**
 * WHAT THEY ACCEPTED, IN ONE SENTENCE, AND THE THREE STATES SAID DIFFERENTLY.
 *
 * The middle one is the state every affiliate who joined before publication is in, so it is written
 * for them rather than treated as a gap: there IS no version, and saying "version unknown" would
 * read as a fault in our records when it is a fact about the order things happened in.
 */
function Accepted({ accepted }: { accepted: PortalTermsData['accepted'] }) {
  if (accepted.version && accepted.at) {
    return (
      <p className="text-sm text-ink" data-testid="portal-terms-accepted">
        You accepted <span className="font-semibold">version {accepted.version}</span> of these terms
        on <span className="font-semibold">{accepted.at}</span>.
      </p>
    );
  }
  if (accepted.at) {
    return (
      <p className="text-sm text-ink" data-testid="portal-terms-accepted">
        You accepted these terms on <span className="font-semibold">{accepted.at}</span>. They carried no
        version number then — the full agreement was still being finalised — so what you agreed to is the
        summary below.
      </p>
    );
  }
  return (
    <p className="text-sm text-ink" data-testid="portal-terms-accepted">
      We have no record of when you accepted these terms. That is a gap in our records rather than a
      change to what applies — ring us on{' '}
      <a href={`tel:${COMPANY.phoneE164}`} className="text-accent hover:underline">{COMPANY.phone}</a> and
      we will put it right.
    </p>
  );
}

export default function PortalTerms({ data }: Props) {
  const settled = data.summary ? termsSummary(data.summary) : null;
  return (
    <>
      <Head><title>Affiliate terms — GreaseDesk</title><meta name="robots" content="noindex" /></Head>
      <AffiliatePortalShell active="terms">
        <header className="mb-6">
          <h1 className="text-2xl sm:text-3xl font-extrabold text-ink tracking-tight" data-testid="portal-terms-heading">
            Affiliate terms
          </h1>
          <p className="mt-1 text-sm text-muted">The agreement between you and {COMPANY.legalName}.</p>
        </header>

        <div className="rounded-2xl border border-line bg-surface p-5 shadow-card">
          <Accepted accepted={data.accepted} />
          {/* NAMED, NOT SWAPPED IN. See lib/affiliate-portal-terms: what they accepted is a fact
              about them, and what is published today is a different fact. Both are said. */}
          {data.newerVersion && (
            <p className="mt-3 text-sm text-warn" data-testid="portal-terms-newer">
              A newer version ({data.newerVersion}) has been published since.{' '}
              <a href="/terms" className="text-accent hover:underline">Read the current version</a>.
            </p>
          )}
        </div>

        {data.doc ? (
          <div className="mt-6 bg-surface border border-line rounded-2xl" data-testid="portal-terms-document">
            <PublicDocument title={data.doc.title} body={data.doc.body} version={data.doc.version}
              effectiveFrom={data.doc.effectiveFrom} />
          </div>
        ) : (
          <section className="mt-6 bg-surface border border-line rounded-2xl p-5 sm:p-6 shadow-card"
            data-testid="portal-terms-summary">
            <p className="text-sm text-warn" data-testid="portal-terms-draft-note">{TERMS_SUMMARY_NOTE}</p>
            <div className="mt-6 space-y-6">
              {(settled ?? []).map((s) => (
                <div key={s.heading}>
                  <h2 className="text-base font-semibold text-ink">{s.heading}</h2>
                  <p className="mt-1 text-sm text-muted">{s.body}</p>
                </div>
              ))}
            </div>
            <div className="mt-8 border-t border-line pt-5">
              <h2 className="text-base font-semibold text-ink">Still to come</h2>
              <ul className="mt-2 space-y-2 text-sm text-muted list-disc pl-5">
                {TERMS_SUMMARY_COMING.map((c) => <li key={c}>{c}</li>)}
              </ul>
            </div>
          </section>
        )}

        <p className="mt-6 text-xs text-muted">
          {COMPANY.legalName}, company number {COMPANY.companyNumber}. Questions about the programme:
          call <a href={`tel:${COMPANY.phoneE164}`} className="text-accent hover:underline">{COMPANY.phone}</a>.
        </p>
      </AffiliatePortalShell>
    </>
  );
}

export const getServerSideProps: GetServerSideProps<Props> = async (ctx) => {
  const gate = await requireAffiliatePage(ctx);
  if (!gate.ok) return gate.result as any;

  const data = await affiliatePortalTerms(gate.rep.repId);
  // NULL MEANS THE GUARD PASSED AND THE ROW IS GONE (or is not an affiliate). 404, not a crash —
  // the same rule the dashboard follows, for the same reason.
  if (!data) return { notFound: true };

  return { props: { data: JSON.parse(JSON.stringify(data)) } };
};
