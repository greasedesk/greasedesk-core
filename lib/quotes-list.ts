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

export const QUOTE_FILTERS = ['awaiting', 'accepted', 'declined', 'expired'] as const;
export type QuoteFilter = typeof QUOTE_FILTERS[number];
export const isQuoteFilter = (v: string): v is QuoteFilter => (QUOTE_FILTERS as readonly string[]).includes(v);

export const DEFAULT_QUOTE_FILTER: QuoteFilter = 'awaiting'; // the chase list = the working view

/** Expiry is sent_at + the magic-link window. Same number the customer's link honours. */
export const quoteExpiry = (sentAt: Date): Date => new Date(sentAt.getTime() + MAGIC_LINK_DAYS * 86_400_000);

export type DerivedQuoteStatus = QuoteFilter;

/**
 * The status a row is FILED UNDER.
 *  accepted / declined — the customer answered; terminal, and both stay visible under their filter
 *    (a declined quote is a follow-up opportunity, not a dead record).
 *  awaiting — still out, still inside its window. The chase list.
 *  expired — out of time with no answer. ALSO where a `superseded` latest lands: the garage edited
 *    the estimate and never re-sent, so there is no live offer — it needs re-sending exactly like
 *    one that timed out.
 */
export function deriveQuoteStatus(
  v: { status: string; sent_at: Date },
  now: Date = new Date(),
): DerivedQuoteStatus {
  if (v.status === 'accepted') return 'accepted';
  if (v.status === 'declined') return 'declined';
  if (v.status === 'superseded') return 'expired';
  return quoteExpiry(v.sent_at).getTime() <= now.getTime() ? 'expired' : 'awaiting';
}

/** Card statuses that mean the work has moved ON from being a quote. */
export const DELIVERED_STATUSES = ['invoiced', 'paid', 'done'] as const;

export type QuoteRow = {
  jobCardId: string;
  quoteVersionId: string | null; // null = verbal quote, never sent
  version: number | null;
  /** TRUE when the card is marked quoted but nothing was ever sent. */
  verbal: boolean;
  registration: string | null;
  customerName: string | null;
  grossPennies: number;
  sentAt: string | null;
  expiresAt: string | null;
  status: DerivedQuoteStatus;
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
    rows.push({
      jobCardId: v.job_card_id,
      quoteVersionId: v.id,
      version: v.version,
      verbal: false,
      registration: v.job_card?.vehicle?.registration ?? null,
      customerName: v.job_card?.customer?.name ?? null,
      grossPennies: v.gross_pennies,
      sentAt: v.sent_at.toISOString(),
      expiresAt: quoteExpiry(v.sent_at).toISOString(),
      status: deriveQuoteStatus({ status: v.status, sent_at: v.sent_at }, now),
      cardStatus: v.job_card?.status ?? '',
      siteId: v.job_card?.site_id ?? '',
    });
  }

  // ── VERBAL QUOTES: cards sitting at `quoted` with NO version at all. ──
  const verbalCards = (await prisma.jobCard.findMany({
    where: { group_id: args.groupId, site_id: { in: args.siteIds }, status: 'quoted', id: { notIn: [...seen] } },
    select: {
      id: true, status: true, site_id: true, created_at: true,
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
      registration: c.vehicle?.registration ?? null,
      customerName: c.customer?.name ?? null,
      grossPennies: gross,
      sentAt: null,
      expiresAt: null, // nothing was sent, so nothing lapses — a verbal quote never "expires"
      status: 'awaiting',
      cardStatus: c.status,
      siteId: c.site_id,
    });
  }

  let filtered = args.filter ? rows.filter((r) => r.status === args.filter) : rows;
  // ACCEPTED IS BOUNDED BY STATE, NOT DATE: once a card is invoiced/paid/done it is delivered work
  // and lives in Job Cards + Invoices. Accepted then settles at "accepted but not yet delivered" —
  // a working list rather than an archive, with no arbitrary cutoff to explain.
  if (args.filter === 'accepted') {
    filtered = filtered.filter((r) => !(DELIVERED_STATUSES as readonly string[]).includes(r.cardStatus));
  }
  filtered.sort((a, b) =>
    args.filter === 'awaiting'
      // Soonest to lapse first; verbal quotes have no clock, so they sort after the timed ones.
      ? (a.expiresAt ?? '9999').localeCompare(b.expiresAt ?? '9999')
      : (b.sentAt ?? '').localeCompare(a.sentAt ?? ''),
  );
  return filtered;
}

/** Counts for the filter chips — computed from the same derivation, so they always agree. */
export async function quoteFilterCounts(args: { groupId: string; siteIds: string[]; now?: Date }) {
  const all = await listQuotes({ ...args, filter: null });
  return QUOTE_FILTERS.reduce((acc, f) => {
    acc[f] = all.filter((r) => r.status === f).length;
    return acc;
  }, {} as Record<QuoteFilter, number>);
}
