/**
 * File: lib/tenant-data-start.ts
 * WHEN a tenant's records begin — the one place that answers it, so the dashboard cannot report
 * £0.00 for a month in which the garage did not yet exist.
 *
 * ── ZERO AND NOTHING ARE DIFFERENT ANSWERS ──────────────────────────────────────────────────────
 * "You sold £0.00 of labour in September 2025" is a claim about September 2025. For a tenant whose
 * first record is May 2026 it is not a true one — nobody measured that month, and the figure is an
 * artefact of an empty query, not a finding. Extending the period picker to twelve months makes
 * those months reachable for every tenant younger than a year, so the distinction has to be drawn
 * before the months are offered.
 *
 * ── IT IS THE EARLIEST RECORD, NOT THE GROUP'S created_at ───────────────────────────────────────
 * A tenant can legitimately hold records that PREDATE its GreaseDesk account: historical invoices
 * are entered against the date printed on the original document (see lib/historical-invoice), so
 * ZZ Gate Garage was created on 2026-07-26 and carries an invoice dated 2026-05-12. Using account
 * creation would hide two real months. The start is therefore the earliest thing actually recorded.
 *
 * ── GROUP-WIDE, NOT SITE-SCOPED, DELIBERATELY ───────────────────────────────────────────────────
 * The question is "when do this garage's records begin", not "when did this site open". A site
 * added later showing zeros for months before it existed is a real and separate problem; answering
 * it here would silently change what the all-sites view means.
 */
import { prisma } from '@/lib/db';

/** The earliest recorded business event, or null when the tenant has recorded nothing at all. */
export async function getTenantDataStart(groupId: string): Promise<Date | null> {
  const [inv, card] = await Promise.all([
    prisma.invoice.findFirst({ where: { group_id: groupId }, orderBy: { date_issued: 'asc' }, select: { date_issued: true } }),
    prisma.jobCard.findFirst({ where: { group_id: groupId }, orderBy: { created_at: 'asc' }, select: { created_at: true } }),
  ]);
  const dates = [inv?.date_issued, card?.created_at].filter(Boolean) as Date[];
  if (!dates.length) return null;
  return dates.reduce((a, b) => (a < b ? a : b));
}

/**
 * TRUE when the whole selected window closes before the first record — i.e. nothing in it was ever
 * measured. `to` is EXCLUSIVE throughout the period engine, so `to <= dataStart` means the window
 * ends at or before the first record and cannot contain it.
 *
 * A tenant with NO records at all (dataStart null) has no measured period, so every window
 * precedes its data. That is the honest answer for a brand-new account and it is why this returns
 * true rather than false on null — the alternative reports zeros to someone who has entered
 * nothing, which is the exact failure this exists to prevent.
 */
export function precedesData(windowTo: Date, dataStart: Date | null): boolean {
  if (dataStart == null) return true;
  return windowTo.getTime() <= dataStart.getTime();
}

export type ClippedWindow = {
  from: Date; to: Date;
  /** The window began before the first record and its start was moved forward. */
  clipped: boolean;
  /** Nothing in the window was ever measured — do not report a figure for it at all. */
  empty: boolean;
};

/**
 * ── THE STRADDLING WINDOW, WHICH precedesData ALONE CANNOT SEE ──────────────────────────────────
 * precedesData asks whether the WHOLE window closes before the first record. That is the right
 * question for a period entirely in the void, and the wrong one for a period with one foot in it.
 *
 * Measured on production before this existed: a tenant whose records begin 2025-08-11, asked for
 * the financial year 2025-04-01 → 2026-04-01, was told it ran at 38.17% and shown a RED light. The
 * four and a half months before it existed contributed 977.6 sellable hours and, necessarily, no
 * sales. The months the garage actually traded ran at 62.66% — amber. The guard did not fire,
 * because the window's END is long after the first record; nothing was lying, the denominator was
 * simply counting capacity for months nobody lived through.
 *
 * SO THE START IS CLIPPED, NOT THE FIGURE SUPPRESSED. Sellable capacity is a projection from the
 * roster and it will happily accrue for any dates you hand it, including dates before the garage
 * opened; the sold side cannot, because invoices that do not exist cannot be counted. Clipping the
 * window forward makes both sides describe the same stretch of time. Discarding the whole period
 * instead would throw away eight true months to avoid four false ones.
 *
 * `clipped` travels with the result so a surface can SAY the period was shortened. A figure that
 * quietly describes a different window than its label is the failure one step removed.
 */
export function clipToData(from: Date, to: Date, dataStart: Date | null): ClippedWindow {
  if (dataStart == null || to.getTime() <= dataStart.getTime()) {
    return { from, to, clipped: false, empty: true };
  }
  if (from.getTime() >= dataStart.getTime()) return { from, to, clipped: false, empty: false };
  return { from: dataStart, to, clipped: true, empty: false };
}
