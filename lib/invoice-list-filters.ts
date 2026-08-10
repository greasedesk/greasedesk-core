/**
 * File: lib/invoice-list-filters.ts
 * ONE definition of the Invoices list's filter semantics — shared by GET /api/invoices and the
 * reconciliation matrix, so a dashboard tile and the list it navigates to can never disagree.
 * Each status key carries its period BASIS: 'paid' buckets by effectivePaidDate (cash basis —
 * row-level filter, the fallback can't be a plain SQL clause), 'issue' buckets by the effective
 * issue date (billing basis — SQL via effectiveIssueDateWhere). Point-in-time keys (unpaid,
 * pending) are meaningful without a period; a period, when passed, still applies on their basis.
 */
import { effectiveIssueDateWhere, effectivePaidDate } from '@/lib/invoice';
import { overdueWhere } from '@/lib/account-terms';

export const LIST_STATUS_KEYS = ['all', 'unpaid', 'overdue', 'pending', 'paid', 'warranty', 'issued', 'void', 'historical'] as const;
export type ListStatusKey = typeof LIST_STATUS_KEYS[number];

const STATUS_WHERE: Record<ListStatusKey, object> = {
  all: {},
  // CHASER EXCLUSION, at the one chokepoint rather than per-surface: an IMPORTED invoice is a
  // historical record that was already settled in the previous system, so it must never appear in
  // the debtors view or be chased. It stays visible in `all`/`paid` — excluded from pursuit, not
  // from the ledger.
  // Names a status, so a VOID is already excluded — a retired document is not a debt. Do NOT
  // spread `notVoided` in here: it would clobber `status: 'issued'` and start counting paid ones.
  unpaid: { status: 'issued', series: 'chargeable', is_imported: false }, // the debtors view (point-in-time)
  // OVERDUE is a STRICT SUBSET of unpaid — the same chaser exclusions, plus a deadline that has
  // passed. It answers a different question: `unpaid` is "what is out there", most of which is
  // cars still on the ramp, while this is "who is actually late".
  //
  // The NULL exclusion inside overdueWhere carries the whole back catalogue: every invoice raised
  // before due_date existed has one, and they are retail work paid on collection. Reading NULL as
  // "due immediately" would have declared years of settled trade overdue on the day this deployed.
  overdue: { ...overdueWhere(), series: 'chargeable', is_imported: false },
  pending: { status: 'paid_pending' },                // clearance window (point-in-time)
  paid: { status: 'paid' },
  warranty: { series: 'warranty' },
  // Retired documents, retained and findable. VATREC5010's first limb is that the cancelled invoice
  // is kept in the records — a filter that surfaces them is what makes "kept" mean "reachable".
  void: { status: 'void' },
  // Records of invoices issued elsewhere. Findable as a set — an operator working through a stack
  // of PDFs needs to see what has already been recorded.
  historical: { series: 'historical' },
  // ARRIVAL-ONLY and deliberately status-blind, so this DOES still list voids. That is correct for
  // a list whose job is "what was raised in this period" — the void filter and the struck-through
  // row are display work (step 3), not an exclusion. It feeds no money tile.
  issued: { series: 'chargeable' },                   // arrival-only: "issued in period", any status
};

const PERIOD_BASIS: Record<ListStatusKey, 'paid' | 'issue'> = {
  all: 'issue', unpaid: 'issue', overdue: 'issue', pending: 'issue', warranty: 'issue', issued: 'issue', void: 'issue', historical: 'issue',
  paid: 'paid',
};

export function isListStatusKey(v: string): v is ListStatusKey {
  return (LIST_STATUS_KEYS as readonly string[]).includes(v);
}

/** The prisma where fragment for a status key + optional period. When the basis is 'paid' the
 *  period can't be expressed in SQL (date_paid ?? paid_at) — the caller must also apply
 *  paidPeriodFilter to the fetched rows. */
export function listWhere(key: ListStatusKey, range: { from: Date; to: Date } | null) {
  // `overdue` is the one key whose predicate depends on the clock, so it is rebuilt per call.
  // Taken from the frozen table it would compare against whenever the process booted — invisible
  // in a serverless function that lives seconds, and quietly wrong in one that lives days.
  const base = key === 'overdue'
    ? { ...STATUS_WHERE.overdue, ...overdueWhere() }
    : STATUS_WHERE[key];
  if (!range) return { where: base, paidRange: null as { from: Date; to: Date } | null };
  if (PERIOD_BASIS[key] === 'paid') return { where: base, paidRange: range };
  return { where: { ...base, ...effectiveIssueDateWhere(range.from, range.to) }, paidRange: null };
}

/** Row-level period filter for the 'paid' basis (mirror of the revenue tile's bucketing). */
export function paidPeriodFilter(r: { date_paid: Date | null; paid_at: Date | null }, range: { from: Date; to: Date }): boolean {
  const d = effectivePaidDate(r);
  return !!d && d >= range.from && d < range.to;
}
