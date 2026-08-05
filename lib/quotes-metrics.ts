/**
 * File: lib/quotes-metrics.ts
 * PERIOD figures for the quotes panel. Deliberately NOT built on listQuotes.
 *
 * ── WHY NOT listQuotes ──────────────────────────────────────────────────────────────────────────
 * listQuotes answers "what is on my plate right now": one row per card at its LATEST version, with
 * delivered work (invoiced/paid/done/cancelled) excluded. Both properties are right for a worklist
 * and fatal for a period figure. A quote accepted in March whose card is invoiced in April would
 * DISAPPEAR from March — a historic total that shrinks as work completes is not a total. And a card
 * holding an accepted v1 behind a sent v4 contributes one row whose acceptance is invisible.
 *
 * So this is a second AGGREGATION, not a second RULE: the vocabulary — what counts as expiry, which
 * card states close a quote — is imported from lib/quotes-list, never restated. The count-versus-
 * list divergence that started this thread came from two expressions of ONE rule; this is one
 * expression of the rule serving two different questions.
 *
 * ── THE HISTORY BOUNDARY, AND WHY THIS READS AuditLog ───────────────────────────────────────────
 * JobCard.accepted_at only exists from 2026-08-05 (lib/quote-acceptance). Every acceptance before
 * that has none: 0 of 205 accepted-or-beyond cards on the live tenant. Bucketing purely on that
 * column would report almost no acceptances for any historic period and would look like a quiet
 * year rather than a missing column — under-reporting that reads as fact.
 *
 * Those acceptances ARE dated, across the three retired actions (`quote.accepted`, `accept.booked`,
 * `quote.accepted_verbal`), and the coverage is complete: 206 distinct cards for 205 accepted
 * cards. So the resolver takes the UNION, in one place, with a fixed precedence, and the panel
 * SAYS SO on screen. AuditLog is not becoming a reporting source in general — it is the fallback
 * for rows that predate the column, and it stops mattering as the estate rolls forward.
 */
import { prisma } from '@/lib/db';
import { quoteExpiry, QUOTE_CLOSED_CARD_STATUSES } from '@/lib/quotes-list';
import { MAGIC_LINK_DAYS } from '@/lib/magic-link';
import { isBookedCard } from '@/lib/jobcard-status';

/** Card states that mean the customer said yes, whatever happened afterwards. */
const ACCEPTED_ONWARD = ['accepted', 'in_progress', 'invoiced', 'paid', 'done'] as const;

/** The three actions that have ever recorded an acceptance. Retired ones included BY DESIGN —
 *  they are the only dated evidence for anything before the chokepoint existed. */
const ACCEPTANCE_ACTIONS = ['quote.accepted', 'accept.booked', 'quote.accepted_verbal'] as const;

export type QuotesMetrics = {
  awaitingPennies: number; awaitingCount: number; awaitingVerbalCount: number;
  acceptedPennies: number; acceptedCount: number;
  acceptedBookedPennies: number; acceptedBookedCount: number;  // SUBSET of accepted, never an addend
  acceptedVerbalCount: number;
  declinedPennies: number; declinedCount: number;
  expiredPennies: number; expiredCount: number;
  /** Cohort basis: of quotes SENT in the period, how many were accepted (ever). */
  cohortSentCount: number; cohortAcceptedCount: number; conversionPct: number | null;
  /** Formal quotes only — a verbal quote has no send date to measure from. */
  avgDaysToResponse: number | null; avgDaysSample: number;
  /** Cohort buckets for the chart, oldest first. */
  series: Array<{ key: string; label: string; quotedPennies: number; acceptedPennies: number; incomplete: boolean }>;
  /** How many figures in this period lean on the pre-cutover audit fallback. Drives the on-screen note. */
  historicDatedCount: number;
};

const dayMs = 86_400_000;
const ym = (d: Date) => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
const ymd = (d: Date) => d.toISOString().slice(0, 10);

/**
 * ONE resolver for "when was this card accepted". Precedence is fixed and total:
 *   1. JobCard.accepted_at        — authoritative, written by the acceptance chokepoint
 *   2. the accepted version's responded_at — stored, precise, pre-dates the column
 *   3. the earliest acceptance AuditLog row — the only date left for older rows
 * Returns null when the card is accepted but NOTHING dates it, which is a real state (ZZ fixtures
 * written directly by script). Such cards are counted as undated rather than dropped or guessed.
 */
function resolveAcceptedAt(
  card: { id: string; accepted_at: Date | null },
  versionRespondedAt: Date | null,
  auditAt: Date | null,
): Date | null {
  return card.accepted_at ?? versionRespondedAt ?? auditAt ?? null;
}

export async function computeQuotesMetrics(args: {
  groupId: string; siteIds: string[]; from: Date; to: Date; now?: Date;
}): Promise<QuotesMetrics> {
  const now = args.now ?? new Date();
  const empty: QuotesMetrics = {
    awaitingPennies: 0, awaitingCount: 0, awaitingVerbalCount: 0,
    acceptedPennies: 0, acceptedCount: 0, acceptedBookedPennies: 0, acceptedBookedCount: 0, acceptedVerbalCount: 0,
    declinedPennies: 0, declinedCount: 0, expiredPennies: 0, expiredCount: 0,
    cohortSentCount: 0, cohortAcceptedCount: 0, conversionPct: null,
    avgDaysToResponse: null, avgDaysSample: 0, series: [], historicDatedCount: 0,
  };
  if (!args.siteIds.length) return empty;

  const [versions, cards, auditRows] = await Promise.all([
    prisma.quoteVersion.findMany({
      where: { group_id: args.groupId, job_card: { site_id: { in: args.siteIds } } },
      orderBy: [{ job_card_id: 'asc' }, { version: 'asc' }],
      select: { id: true, job_card_id: true, version: true, status: true, sent_at: true, responded_at: true, gross_pennies: true },
    }),
    // Every card that reached acceptance, plus the estimate value for the ones with no version.
    prisma.jobCard.findMany({
      where: { group_id: args.groupId, site_id: { in: args.siteIds }, status: { in: [...ACCEPTED_ONWARD, 'declined'] as any } },
      select: {
        id: true, status: true, accepted_at: true, resource_id: true, start_at: true, end_at: true,
        items: { select: { qty: true, unit_price: true, vat_amount: true } },
      },
    }),
    // ONE aggregate, small result: the earliest acceptance row per card. The fallback for anything
    // that predates JobCard.accepted_at.
    prisma.auditLog.groupBy({
      by: ['entity_id'],
      where: { group_id: args.groupId, action: { in: ACCEPTANCE_ACTIONS as unknown as string[] } },
      _min: { created_at: true },
    }) as any,
  ]);

  const auditAt = new Map<string, Date>();
  for (const r of auditRows as Array<{ entity_id: string; _min: { created_at: Date | null } }>) {
    if (r._min.created_at) auditAt.set(r.entity_id, r._min.created_at);
  }

  const byCard = new Map<string, typeof versions>();
  for (const v of versions) byCard.set(v.job_card_id, [...(byCard.get(v.job_card_id) ?? []), v]);

  const inWindow = (d: Date | null | undefined) => !!d && d.getTime() >= args.from.getTime() && d.getTime() < args.to.getTime();
  const liveGross = (items: Array<{ qty: any; unit_price: any; vat_amount: any }>) =>
    items.reduce((s, it) => s + Math.round(Number(it.qty) * Number(it.unit_price) * 100) + Math.round(Number(it.vat_amount) * 100), 0);

  const m: QuotesMetrics = { ...empty, series: [] };

  // ── ACCEPTED / DECLINED — outcome-dated, verbal included ──────────────────────────────────────
  for (const c of cards) {
    const vs = byCard.get(c.id) ?? [];
    const acceptedV = [...vs].reverse().find((v) => v.status === 'accepted') ?? null;

    if ((ACCEPTED_ONWARD as readonly string[]).includes(c.status)) {
      const at = resolveAcceptedAt(c, acceptedV?.responded_at ?? null, auditAt.get(c.id) ?? null);
      if (inWindow(at)) {
        // Value = what was AGREED where a version records it, else the live estimate — the same
        // honesty listQuotes applies to a verbal quote: never invent a figure nobody agreed to.
        const value = acceptedV?.gross_pennies ?? liveGross(c.items);
        m.acceptedPennies += value; m.acceptedCount += 1;
        if (!acceptedV) m.acceptedVerbalCount += 1;
        if (c.accepted_at == null) m.historicDatedCount += 1; // dated by the fallback, not the column
        if (isBookedCard(c)) { m.acceptedBookedPennies += value; m.acceptedBookedCount += 1; }
      }
    }

  }

  // ── DECLINED — FROM THE VERSION, NEVER THE CARD ───────────────────────────────────────────────
  // This used to sit in the card loop above, gated on `c.status === 'declined'`, and reported
  // £0.00 while the Declined tab showed a row. Declining DELIBERATELY leaves the card where it is
  // ("the garage decides what to do next" — quote-respond), so a declined quote's card is usually
  // still `quoted` and never entered that query at all. Acceptance moves the card, so the same
  // shape worked there and hid the difference. Decline is a fact about the VERSION and is read
  // from the version, exactly as deriveQuoteStatus does for the tab.
  //
  // Counted per DECLINED VERSION, not per card: if a customer declined v1 in August and the garage
  // re-quoted, that decline still happened in August. Filing it under the card's latest version
  // would make a historic figure move when a new quote is sent — the failure this module exists to
  // avoid. Same grain as Expired, which is also per version.
  for (const v of versions) {
    if (v.status !== 'declined') continue;
    if (!inWindow(v.responded_at)) continue;
    m.declinedPennies += v.gross_pennies; m.declinedCount += 1;
  }

  // ── EXPIRED — derived, never stored. Versions still `sent` whose window closed in the period. ──
  // Superseded versions are EXCLUDED: nothing records when a supersede happened (no timestamp, no
  // updated_at), so filing one under a month would be a guess dressed as a figure.
  // Closed cards are NOT excluded here, deliberately: whether the work later went ahead does not
  // change the fact that this offer lapsed unanswered in this period. Excluding them would make a
  // historic total shrink as jobs complete, which is the failure this whole module exists to avoid.
  for (const v of versions) {
    if (v.status !== 'sent') continue;
    if (inWindow(quoteExpiry(v.sent_at))) { m.expiredPennies += v.gross_pennies; m.expiredCount += 1; }
  }

  // ── COHORT: of quotes SENT in this period, how many were accepted — and the chart series ──────
  // Bucketed by SEND date, which is what makes the two lines commensurable and the ratio a real
  // conversion rate. Formal quotes only: a verbal quote has no send date to bucket by, so it is
  // structurally absent here even though it counts in Accepted above. The panel says so.
  const firstByCard = new Map<string, { sentAt: Date; gross: number }>();
  for (const v of versions) if (!firstByCard.has(v.job_card_id)) firstByCard.set(v.job_card_id, { sentAt: v.sent_at, gross: v.gross_pennies });
  const acceptedCards = new Set(cards.filter((c: any) => (ACCEPTED_ONWARD as readonly string[]).includes(c.status)).map((c: any) => c.id));
  const acceptedValueOf = new Map<string, number>();
  for (const v of versions) if (v.status === 'accepted') acceptedValueOf.set(v.job_card_id, v.gross_pennies);

  const spanDays = Math.round((args.to.getTime() - args.from.getTime()) / dayMs);
  const monthly = spanDays > 62;
  const buckets = new Map<string, { label: string; quoted: number; accepted: number; startMs: number; endMs: number }>();
  const bucketFor = (d: Date) => {
    if (monthly) {
      const k = ym(d);
      const end = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
      return { k, label: new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)).toISOString().slice(0, 7), end };
    }
    const k = ymd(d);
    return { k, label: k, end: Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1) };
  };
  // Pre-seed every bucket in the window so an empty month plots as a TRUE zero rather than a gap.
  for (let t = args.from.getTime(); t < args.to.getTime();) {
    const d = new Date(t);
    const b = bucketFor(d);
    if (!buckets.has(b.k)) buckets.set(b.k, { label: b.label, quoted: 0, accepted: 0, startMs: t, endMs: b.end });
    t = b.end;
  }

  for (const [cardId, f] of firstByCard) {
    if (!inWindow(f.sentAt)) continue;
    m.cohortSentCount += 1;
    const b = bucketFor(f.sentAt);
    const row = buckets.get(b.k) ?? { label: b.label, quoted: 0, accepted: 0, startMs: f.sentAt.getTime(), endMs: b.end };
    row.quoted += f.gross;
    if (acceptedCards.has(cardId)) {
      m.cohortAcceptedCount += 1;
      row.accepted += acceptedValueOf.get(cardId) ?? f.gross;
    }
    buckets.set(b.k, row);
  }
  m.conversionPct = m.cohortSentCount ? Math.round((m.cohortAcceptedCount / m.cohortSentCount) * 1000) / 10 : null;

  // ── MATURITY, AND THE DIFFERENCE BETWEEN "OPEN" AND "HASN'T HAPPENED" ────────────────────────
  // A bucket is INCOMPLETE when quotes were sent into it but it has not yet had the full expiry
  // window to be answered. A bucket that lies entirely in the FUTURE is neither incomplete nor
  // empty — nothing has happened in it yet, and it is not a cohort at all. Selecting the current
  // month used to hatch every remaining day of it, filling most of the plot with texture that read
  // as a rendering fault and said nothing true. Future buckets are DROPPED, not drawn flat: a zero
  // bar for next Tuesday asserts a measurement nobody has taken.
  const nowMs = now.getTime();
  const matureBefore = nowMs - MAGIC_LINK_DAYS * dayMs;
  m.series = [...buckets.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .filter(([, v]) => v.startMs <= nowMs)   // the bucket has begun
    .map(([key, v]) => ({
      key, label: v.label, quotedPennies: v.quoted, acceptedPennies: v.accepted,
      // Only a bucket that has STARTED can be immature, and only while its end is still inside the
      // window. A closed month from last year is complete; this week is not.
      incomplete: v.endMs > matureBefore,
    }));

  // ── AVERAGE DAYS SEND → RESPONSE — formal quotes only, and said so on screen. ─────────────────
  const gaps: number[] = [];
  for (const v of versions) {
    if (!v.responded_at || !inWindow(v.responded_at)) continue;
    gaps.push((v.responded_at.getTime() - v.sent_at.getTime()) / dayMs);
  }
  m.avgDaysSample = gaps.length;
  m.avgDaysToResponse = gaps.length ? Math.round((gaps.reduce((a, b) => a + b, 0) / gaps.length) * 10) / 10 : null;

  return m;
}

/** Re-exported so a caller cannot accidentally restate the closed-card list. */
export { QUOTE_CLOSED_CARD_STATUSES };
