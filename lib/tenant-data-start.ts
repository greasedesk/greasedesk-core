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
