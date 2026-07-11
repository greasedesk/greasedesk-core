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

export const LIST_STATUS_KEYS = ['all', 'unpaid', 'pending', 'paid', 'warranty', 'issued'] as const;
export type ListStatusKey = typeof LIST_STATUS_KEYS[number];

const STATUS_WHERE: Record<ListStatusKey, object> = {
  all: {},
  unpaid: { status: 'issued', series: 'chargeable' }, // the debtors view (point-in-time)
  pending: { status: 'paid_pending' },                // clearance window (point-in-time)
  paid: { status: 'paid' },
  warranty: { series: 'warranty' },
  issued: { series: 'chargeable' },                   // arrival-only: "issued in period", any status
};

const PERIOD_BASIS: Record<ListStatusKey, 'paid' | 'issue'> = {
  all: 'issue', unpaid: 'issue', pending: 'issue', warranty: 'issue', issued: 'issue',
  paid: 'paid',
};

export function isListStatusKey(v: string): v is ListStatusKey {
  return (LIST_STATUS_KEYS as readonly string[]).includes(v);
}

/** The prisma where fragment for a status key + optional period. When the basis is 'paid' the
 *  period can't be expressed in SQL (date_paid ?? paid_at) — the caller must also apply
 *  paidPeriodFilter to the fetched rows. */
export function listWhere(key: ListStatusKey, range: { from: Date; to: Date } | null) {
  const base = STATUS_WHERE[key];
  if (!range) return { where: base, paidRange: null as { from: Date; to: Date } | null };
  if (PERIOD_BASIS[key] === 'paid') return { where: base, paidRange: range };
  return { where: { ...base, ...effectiveIssueDateWhere(range.from, range.to) }, paidRange: null };
}

/** Row-level period filter for the 'paid' basis (mirror of the revenue tile's bucketing). */
export function paidPeriodFilter(r: { date_paid: Date | null; paid_at: Date | null }, range: { from: Date; to: Date }): boolean {
  const d = effectivePaidDate(r);
  return !!d && d >= range.from && d < range.to;
}
