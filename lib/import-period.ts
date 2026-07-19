/**
 * File: lib/import-period.ts
 * THE one place that decides whether a reporting period is affected by an invoice import, and how
 * far through it is.
 *
 * WHY THIS EXISTS. A partially imported month does not produce approximate figures — it produces
 * WRONG ones. The full month's wages and overheads are charged against whatever fraction of the
 * revenue has been committed so far, so on 1 of 42 invoices May 2026 reported a net profit of
 * −£7,077.61 and 0.3% utilisation. Both are arithmetically correct and completely untrue. The
 * honest-null discipline used for unknown parts cost applies here too: no figure beats a wrong one.
 *
 * THREE STATES, and the marker never disappears once a period is touched:
 *   'none'        — no imported data; report normally.
 *   'in_progress' — a batch overlapping this period still has uncommitted invoices. DERIVED
 *                   figures (net profit, utilisation, break-even) are SUPPRESSED. Revenue and
 *                   parts cost stay, because they are true as far as they go.
 *   'complete'    — every invoice in the batch is resolved, but the period still contains imported
 *                   data carrying ESTIMATED costs and RECONSTRUCTED hours, so it stays marked.
 *
 * Suppression happens SERVER-SIDE — the wrong number is never sent to the browser, matching the
 * "absent, not hidden" rule the finance-visibility work established.
 */
import { prisma } from '@/lib/db';

export type ImportPeriodState = 'none' | 'in_progress' | 'complete';

export type ImportPeriod = {
  state: ImportPeriodState;
  /** Invoices in the overlapping batch(es) that have been committed. */
  committed: number;
  /** Invoices in the overlapping batch(es) in total (committed + pending + in-progress). */
  total: number;
  /** Deliberately excluded from `total`'s denominator sense — skipped is a decision, not a gap. */
  skipped: number;
  /** Batch labels, for the marker text. */
  labels: string[];
  /** True when derived figures must be withheld. */
  suppressDerived: boolean;
};

export const NO_IMPORT: ImportPeriod = {
  state: 'none', committed: 0, total: 0, skipped: 0, labels: [], suppressDerived: false,
};

/**
 * Resolve the import state for [from, to). Keyed on the STAGED invoices' issue dates, because that
 * is what determines which reporting period the batch lands in — not when the batch was uploaded.
 */
export async function periodImportState(
  groupId: string,
  siteIds: string[],
  from: Date,
  to: Date,
): Promise<ImportPeriod> {
  // Staged invoices whose PRINTED date falls in this period, whatever their status.
  const staged = await prisma.stagedInvoice.findMany({
    where: {
      group_id: groupId,
      issue_date: { gte: from, lt: to },
      batch: { site_id: { in: siteIds } },
    },
    select: { status: true, batch: { select: { label: true, status: true } } },
  }) as Array<{ status: string; batch: { label: string; status: string } }>;

  if (!staged.length) {
    // No batch covers this period — but imported invoices may still sit in it from an older run.
    const imported = await prisma.invoice.count({
      where: { group_id: groupId, site_id: { in: siteIds }, is_imported: true,
        OR: [{ date_issued: { gte: from, lt: to } }, { date_issued: null, issued_at: { gte: from, lt: to } }] },
    });
    return imported > 0
      ? { state: 'complete', committed: imported, total: imported, skipped: 0, labels: [], suppressDerived: false }
      : NO_IMPORT;
  }

  const committed = staged.filter((s: any) => s.status === 'committed').length;
  const skipped = staged.filter((s: any) => s.status === 'skipped').length;
  const total = staged.length;
  const labels = Array.from(new Set(staged.map((s: any) => String(s.batch.label)))) as string[];

  // THE BATCH DECIDES, not a headcount of its invoices. The batch advances to `committed` inside
  // the same transaction as the last commit or skip, so it is the authoritative answer to "is this
  // import finished?" — and it stays authoritative for a batch that legitimately covers two
  // periods, where counting rows in ONE period could call a half-done import complete.
  // The counts below still feed the marker's wording; they no longer decide the state.
  const closed = staged.every((s: any) => s.batch.status === 'committed' || s.batch.status === 'abandoned');
  const outstanding = total - committed - skipped;

  if (!closed || outstanding > 0) {
    return { state: 'in_progress', committed, total, skipped, labels, suppressDerived: true };
  }
  return { state: 'complete', committed, total, skipped, labels, suppressDerived: false };
}

/** The marker sentence. States INCOMPLETENESS, not merely provenance. */
export function importMarkerText(p: ImportPeriod, periodLabel: string): string | null {
  if (p.state === 'none') return null;
  if (p.state === 'in_progress') {
    const skipNote = p.skipped ? `, ${p.skipped} skipped` : '';
    return `${periodLabel}: import in progress, ${p.committed} of ${p.total} invoices committed${skipNote}. These figures are partial — profit, utilisation and break-even are withheld until the import completes.`;
  }
  return `${periodLabel}: contains imported invoices. Parts costs may be estimated and labour hours reconstructed from the original documents.`;
}
