/**
 * File: lib/quotes-list.ts
 * THE resolver for the Quotes lens. A quote is not a new object — it is a job card in waiting — so
 * this returns ONE ROW PER CARD at its LATEST version. A card whose v1 was superseded by v2 is one
 * row showing v2.
 *
 * COVERS VERBAL QUOTES TOO. Most quoting happens over the counter or by phone: the card is marked
 * `quoted` and nothing is ever sent. Those cards have NO QuoteVersion, and a list built only from
 * versions would miss the commoner case entirely. So the list is the UNION — cards with a sent
 * version (dates, expiry, version, frozen value) and cards merely marked `quoted` (value read live
 * off the estimate, flagged "quoted verbally"). Both are chaseable; this is the complete quoting
 * picture, not the subset that used the formal flow.
 *
 * EXPIRY IS DERIVED, NEVER STORED. A quote sent 15 days ago with no answer is expired whether or not
 * any job ran, any cron fired, or anyone opened the link. Deriving it from sent_at + MAGIC_LINK_DAYS
 * means the list can never disagree with what the customer's link actually does.
 */
import { prisma } from '@/lib/db';
import { MAGIC_LINK_DAYS } from '@/lib/magic-link';
import { isBookedCard } from '@/lib/jobcard-status';

export const QUOTE_FILTERS = ['awaiting', 'accepted', 'declined', 'needs_resending', 'expired', 'accepted_booked'] as const;
export type QuoteFilter = typeof QUOTE_FILTERS[number];
export const isQuoteFilter = (v: string): v is QuoteFilter => (QUOTE_FILTERS as readonly string[]).includes(v);

export const DEFAULT_QUOTE_FILTER: QuoteFilter = 'awaiting'; // the chase list = the working view

/** Expiry is sent_at + the magic-link window. Same number the customer's link honours. */
export const quoteExpiry = (sentAt: Date): Date => new Date(sentAt.getTime() + MAGIC_LINK_DAYS * 86_400_000);

export type DerivedQuoteStatus = QuoteFilter;

/**
 * The status a row is FILED UNDER.
 *  accepted — the customer said yes and NOBODY HAS BOOKED IT. This is the to-do list, and it is the
 *    gap nothing else in the product catches: an accepted job with no lift and no date is invisible
 *    on the diary and finished on the quotes list, so it can sit indefinitely.
 *  accepted_booked — said yes AND in the diary. Agreed work, scheduled, not yet invoiced. It leaves
 *    when the card is invoiced, via the same closed-card predicate as everything else.
 *  declined — the customer answered no; stays visible (a follow-up opportunity, not a dead record).
 *  awaiting — still out, still inside its window. The chase list.
 *  expired — out of time with NO ANSWER. The customer had their chance and didn't take it.
 *  needs_resending — the LATEST version is `superseded`: the garage materially edited the estimate
 *    after sending and never re-sent, so there is no live link and the customer cannot see a price.
 *    This used to collapse into `expired`, which says the OPPOSITE of what happened — expired is
 *    the customer not answering; this is the garage never asking. One is a follow-up, the other is
 *    an outstanding task on our side, and they belong in different queues.
 *    NOTE the "no successor" half is free: listQuotes keeps only each card's HIGHEST version, so a
 *    superseded version that HAS been replaced is already invisible here (its successor is latest).
 *    Reaching this branch therefore means there is no successor.
 */
export function deriveQuoteStatus(
  v: { status: string; sent_at: Date; booked?: boolean },
  now: Date = new Date(),
): DerivedQuoteStatus {
  // The ONLY place the booking fact matters: it splits `accepted` in two and touches nothing else.
  // A superseded or expired version stays what it is whether or not a lift was pencilled in.
  if (v.status === 'accepted') return v.booked ? 'accepted_booked' : 'accepted';
  if (v.status === 'declined') return 'declined';
  if (v.status === 'superseded') return 'needs_resending';
  return quoteExpiry(v.sent_at).getTime() <= now.getTime() ? 'expired' : 'awaiting';
}

/**
 * ── CARD STATES IN WHICH A QUOTE CAN NEVER BE ANSWERED ──────────────────────────────────────────
 * Was `DELIVERED_STATUSES` and lived inside the `accepted` filter branch, so it applied to the ROWS
 * and not to the COUNTS — the Accepted chip said 5 while the list showed 3. It is now applied once,
 * in the derivation, before any filtering, so a count and a list cannot express it differently.
 *
 * `invoiced`/`paid`/`done` — delivered work; it lives in Job Cards and Invoices now.
 * `cancelled` — the job will never happen, so the quote will never be answered. It was excluded
 *   NOWHERE before, so a cancelled card's quote sat in Accepted permanently, unactionable and
 *   accumulating.
 * `declined` is DELIBERATELY ABSENT (ruling 2026-08-05): this file already holds that a declined
 *   quote is a follow-up opportunity rather than a dead record, and a declined CARD is the same
 *   fact one level up. It stays listed under Declined.
 *
 * The card already records all of this. Reading it here — rather than mirroring it into a quote
 * status — is what stops the two drifting apart.
 */
export const QUOTE_CLOSED_CARD_STATUSES = ['invoiced', 'paid', 'done', 'cancelled'] as const;

export type QuoteRow = {
  jobCardId: string;
  quoteVersionId: string | null; // null = verbal quote, never sent
  version: number | null;
  /** TRUE when the card is marked quoted but nothing was ever sent. */
  verbal: boolean;
  /** In the diary: a lift AND a planned time. Read from the card via isBookedCard — never a status. */
  booked: boolean;
  registration: string | null;
  customerName: string | null;
  grossPennies: number;
  sentAt: string | null;
  expiresAt: string | null;
  status: DerivedQuoteStatus;
  /** TRUE when this card's LATEST version is `superseded` — the estimate was materially edited after
   *  sending and never re-sent, so there is NO live link: the customer can no longer view it. Distinct
   *  from a timed-out expiry (both file under `expired`). Clears the moment a fresh quote is sent, as
   *  the new `sent` version becomes the latest. */
  supersededNoLink: boolean;
  cardStatus: string;
  siteId: string;
};

/**
 * Every card's LATEST version, site-scoped, optionally filtered. Ordering puts the most urgent
 * first: for the chase list that is the soonest expiry, otherwise most recently sent.
 */
export async function listQuotes(args: {
  groupId: string;
  siteIds: string[];
  filter?: QuoteFilter | null;
  now?: Date;
}): Promise<QuoteRow[]> {
  const now = args.now ?? new Date();
  if (!args.siteIds.length) return [];

  const versions = (await prisma.quoteVersion.findMany({
    where: { group_id: args.groupId, job_card: { site_id: { in: args.siteIds } } },
    orderBy: [{ job_card_id: 'asc' }, { version: 'desc' }],
    select: {
      id: true, job_card_id: true, version: true, status: true, sent_at: true, gross_pennies: true,
      job_card: {
        select: {
          status: true, site_id: true,
          // The booking fact, read from the card itself — see isBookedCard.
          resource_id: true, start_at: true, end_at: true,
          vehicle: { select: { registration: true } },
          customer: { select: { name: true } },
        },
      },
    },
  })) as any[];

  // ONE ROW PER CARD: the ordering above puts each card's highest version first, so the first
  // sighting of a card_id wins and later (older) versions are skipped.
  const seen = new Set<string>();
  const rows: QuoteRow[] = [];
  for (const v of versions) {
    if (seen.has(v.job_card_id)) continue;
    seen.add(v.job_card_id);
    const booked = v.job_card ? isBookedCard(v.job_card) : false;
    rows.push({
      jobCardId: v.job_card_id,
      quoteVersionId: v.id,
      version: v.version,
      verbal: false,
      booked,
      registration: v.job_card?.vehicle?.registration ?? null,
      customerName: v.job_card?.customer?.name ?? null,
      grossPennies: v.gross_pennies,
      sentAt: v.sent_at.toISOString(),
      expiresAt: quoteExpiry(v.sent_at).toISOString(),
      status: deriveQuoteStatus({ status: v.status, sent_at: v.sent_at, booked }, now),
      supersededNoLink: v.status === 'superseded',
      cardStatus: v.job_card?.status ?? '',
      siteId: v.job_card?.site_id ?? '',
    });
  }

  // ── VERBAL QUOTES: cards sitting at `quoted` with NO version at all. ──
  const verbalCards = (await prisma.jobCard.findMany({
    where: { group_id: args.groupId, site_id: { in: args.siteIds }, status: 'quoted', id: { notIn: [...seen] } },
    select: {
      id: true, status: true, site_id: true, created_at: true,
      resource_id: true, start_at: true, end_at: true,
      vehicle: { select: { registration: true } },
      customer: { select: { name: true } },
      items: { select: { qty: true, unit_price: true, vat_amount: true } },
    },
  })) as any[];
  for (const c of verbalCards) {
    // Value read LIVE off the estimate — there is no frozen version to read, and pretending
    // otherwise would invent a figure nobody agreed to.
    const gross = c.items.reduce(
      (sum: number, it: any) => sum + Math.round(Number(it.qty) * Number(it.unit_price) * 100) + Math.round(Number(it.vat_amount) * 100),
      0,
    );
    rows.push({
      jobCardId: c.id,
      quoteVersionId: null,
      version: null,
      verbal: true,
      booked: isBookedCard(c),
      registration: c.vehicle?.registration ?? null,
      customerName: c.customer?.name ?? null,
      grossPennies: gross,
      sentAt: null,
      expiresAt: null, // nothing was sent, so nothing lapses — a verbal quote never "expires"
      status: 'awaiting',
      supersededNoLink: false, // never sent → no link to have lost
      cardStatus: c.status,
      siteId: c.site_id,
    });
  }

  // BOUNDED BY CARD STATE, BEFORE ANY FILTERING — so the counts and the rows read one rule.
  // Applying this inside the `accepted` branch is what let the chip and the list disagree.
  const open = rows.filter((r) => !(QUOTE_CLOSED_CARD_STATUSES as readonly string[]).includes(r.cardStatus));
  let filtered = args.filter ? open.filter((r) => r.status === args.filter) : open;
  filtered.sort((a, b) =>
    args.filter === 'awaiting'
      // Soonest to lapse first; verbal quotes have no clock, so they sort after the timed ones.
      ? (a.expiresAt ?? '9999').localeCompare(b.expiresAt ?? '9999')
      : (b.sentAt ?? '').localeCompare(a.sentAt ?? ''),
  );
  return filtered;
}

/**
 * Counts for the filter chips. This USED to claim they "always agree" with the rows — a comment
 * asserting a property nothing verified, and it was false: the delivered-work exclusion ran only
 * when a filter was passed, and this calls with `filter: null`. They agree now because the
 * exclusion happens in listQuotes BEFORE filtering, so both callers see the same set by
 * construction — not because a comment says so. The gate asserts chip === rendered rows on EVERY
 * tab, which is the only thing that actually holds the property.
 */
export async function quoteFilterCounts(args: { groupId: string; siteIds: string[]; now?: Date }) {
  const all = await listQuotes({ ...args, filter: null });
  return QUOTE_FILTERS.reduce((acc, f) => {
    acc[f] = all.filter((r) => r.status === f).length;
    return acc;
  }, {} as Record<QuoteFilter, number>);
}
