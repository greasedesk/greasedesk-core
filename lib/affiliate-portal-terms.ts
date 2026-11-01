/**
 * File: lib/affiliate-portal-terms.ts
 * WHAT THE SIGNED-IN AFFILIATE'S TERMS SCREEN SHOWS — the agreement, and what THEY accepted.
 *
 * ── A SEPARATE READ FROM affiliatePortalData, DELIBERATELY ──────────────────────────────────────
 * That function is the dashboard's one fetch and is a seven-deep serial chain; the menu switches
 * sections precisely so the chain is paid once. Terms is a page of its own — a long body somebody
 * opens rarely — so its queries belong to it rather than to every dashboard load. Two of them used
 * to be in that chain, for a footer line: moving them here made the dashboard shorter, not longer.
 *
 * ── THE VERSION THEY ACCEPTED, NOT THE LATEST ONE ───────────────────────────────────────────────
 * RepTermsAcceptance.version is frozen at acceptance, and this reads the DOCUMENT behind it. The
 * alternative — showing today's published version under the sentence "you accepted this" — would
 * be a claim about what somebody agreed to that changes without them, which is the whole reason the
 * content system versions a legal page and bakes its figures at publish.
 *
 * A newer published version is REPORTED, not substituted: `newerVersion` is non-null when one
 * exists, and the page says so and links to it. Silence there would be the opposite error — an
 * affiliate reading an old agreement with nothing to tell them the programme has moved on.
 *
 * ── THREE STATES, AND THE MIDDLE ONE IS REAL ────────────────────────────────────────────────────
 *   a version and a date  — they accepted a published document; it is shown.
 *   a date and NO version — they accepted the SETTLED SUMMARY, before anything was published. There
 *                           is no document to show, and inventing a version stamp for it would
 *                           invent a reference to words that never existed under that name.
 *   neither               — we have no record. Said plainly; not filled in with today.
 */
import type { PrismaClient } from '@prisma/client';
import { prisma as defaultDb } from '@/lib/db';
import { resolvePublished } from '@/lib/content';
import { AFFILIATE_TERMS_SLUG } from '@/lib/affiliate-terms';
import { AFFILIATE_HOLD_DAYS } from '@/lib/affiliate-earnings';
import type { TermsSummaryFigures } from '@/lib/affiliate-terms-summary';

type Db = PrismaClient;

export type PortalTermsDoc = { title: string; body: string; version: string; effectiveFrom: string | null };

export type PortalTermsData = {
  name: string;
  /** Their acceptance. `version` null = they accepted the summary — see the header's three states. */
  accepted: { version: string | null; at: string | null };
  /** The document they accepted, when there is one to show. */
  doc: PortalTermsDoc | null;
  /** A published version later than theirs, named so the page can say so. Null = theirs is current. */
  newerVersion: string | null;
  /** The settled summary's figures — fetched ONLY when there is no document. */
  summary: TermsSummaryFigures | null;
};

const isoDay = (d: Date | null | undefined): string | null => (d ? d.toISOString().slice(0, 10) : null);

export async function affiliatePortalTerms(repId: string, db: Db = defaultDb as Db): Promise<PortalTermsData | null> {
  const rep = await db.rep.findUnique({
    where: { id: repId },
    select: { id: true, name: true, party_type: true, terms_accepted_at: true },
  });
  if (!rep || rep.party_type !== 'affiliate') return null;

  const acceptance = await db.repTermsAcceptance.findFirst({
    where: { rep_id: rep.id },
    orderBy: { accepted_at: 'desc' },
    select: { version: true, accepted_at: true, document_id: true },
  });

  /**
   * THE ROW FIRST, THE REP'S COLUMN SECOND. Rep.terms_accepted_at records THAT they accepted and is
   * written for every affiliate at signup; the acceptance row exists only once a version does. So a
   * signup from before publication has the column and no row, and the date is still knowable.
   */
  const acceptedAt = isoDay(acceptance?.accepted_at ?? rep.terms_accepted_at);

  /**
   * BY ID WHEN WE HAVE IT. The id is the exact row; the version stamp is a key into (slug, country,
   * version) and resolves the same document while the slug is the one it was accepted under. Both
   * are tried because document_id is nullable by design — an acceptance recorded from a stamp alone
   * is a real state, not a broken row.
   */
  let doc: PortalTermsDoc | null = null;
  const row = acceptance?.document_id
    ? await db.document.findUnique({ where: { id: acceptance.document_id } })
    : (acceptance?.version
      ? await db.document.findUnique({
        where: {
          slug_country_code_version: {
            slug: AFFILIATE_TERMS_SLUG, country_code: 'GB', version: acceptance.version,
          },
        },
      })
      : null);
  if (row) {
    doc = {
      title: row.title,
      body: row.body,
      version: row.version,
      effectiveFrom: isoDay(row.effective_from),
    };
  }

  const current = await resolvePublished(db, AFFILIATE_TERMS_SLUG, 'GB');
  /**
   * A NEWER VERSION IS ONE THAT IS NOT THEIRS — compared on the stamp, which is what an acceptance
   * holds. With no acceptance version at all, any published version is newer than what they read,
   * and the page says so rather than leaving a summary looking current.
   */
  const newerVersion = current && current.version !== acceptance?.version ? current.version : null;

  /**
   * THE SUMMARY'S FIGURES, AND ONLY WHEN THEY ARE GOING TO BE SHOWN. Four reads that the common
   * case — a published document — has no use for. Same resolvers as the public page: nothing about
   * the money is typed into a terms screen.
   */
  let summary: TermsSummaryFigures | null = null;
  if (!doc) {
    const { currentTerms } = await import('@/lib/affiliate');
    const { rewardFigures, rewardSentence } = await import('@/lib/affiliate-public');
    const { publicPlanChoice } = await import('@/lib/plan-choice');
    const terms = await currentTerms(db as any);
    const figures = rewardFigures({ totalRewardPennies: terms.totalRewardPennies, instalmentPennies: terms.instalmentPennies });
    const choice = await publicPlanChoice(db as any, { referred: true });
    summary = {
      rewardSentence: rewardSentence(figures),
      totalLabel: figures.totalLabel,
      holdDays: AFFILIATE_HOLD_DAYS,
      garage: {
        offerLabel: choice.annual.totalLabel,
        renewalLabel: choice.annual.renewalTotalLabel,
        monthsPaid: choice.annual.monthsPaid,
        monthsGiven: choice.annual.monthsGiven,
      },
    };
  }

  return {
    name: rep.name,
    accepted: { version: acceptance?.version ?? null, at: acceptedAt },
    doc,
    newerVersion,
    summary,
  };
}
