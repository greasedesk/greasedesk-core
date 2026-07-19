/**
 * File: lib/import-batch.ts
 * Batch-level reads: ingest, VAT variance, and THE reconciliation panel figures.
 *
 * Running totals exist so the month can be SEEN to close — invoices parsed vs committed, parsed
 * gross vs committed gross. A residual is always visible rather than assumed zero.
 */
import { prisma } from '@/lib/db';
import { parseInvoiceText, reconcile, billableLines, type ParsedInvoice } from '@/lib/invoice-parser';
import { computeTax } from '@/lib/tax';
import { getTaxProfile } from '@/lib/tenant-vat';

export type BatchTotals = {
  invoices: { total: number; pending: number; inProgress: number; committed: number; skipped: number };
  reconciliation: { reconciled: number; failed: number };
  money: { parsedNetPennies: number; committedNetPennies: number; residualPennies: number };
  vatVariances: number;
  linesUncosted: number;
};

/** Ingest one extracted text layer into staging. Returns the staged invoice id, or a refusal. */
export async function ingestOne(args: {
  batchId: string;
  groupId: string;
  text: string;
  filenameHint?: string;
}): Promise<{ ok: true; id: string; reconciled: boolean } | { ok: false; reason: string }> {
  const p: ParsedInvoice = parseInvoiceText(args.text);
  const ext = p.externalNumber ?? (args.filenameHint?.match(/\d{6,}/)?.[0] ?? null);
  if (!ext) return { ok: false, reason: 'no invoice number found' };
  if (!p.issueDate) return { ok: false, reason: 'no invoice date found' };

  const r = reconcile(p);

  // VAT is COMPUTED, never taken from the PDF.
  const profile = await getTaxProfile(args.groupId).catch(() => null);
  let vatComputed: number | null = null;
  if (profile) {
    const lines = billableLines(p).map((l) => ({
      netPennies: Math.round(l.qty * l.unitPrice * 100),
      rateBp: /no vat/i.test(l.vatText) ? 0 : Math.round(parseFloat(l.vatText || '0') * 100),
      taxable: !/no vat/i.test(l.vatText) && !!l.vatText,
    })) as any;
    try {
      vatComputed = computeTax(profile as any, lines).taxPennies / 100;
    } catch {
      vatComputed = null;
    }
  }

  const staged = await prisma.stagedInvoice.upsert({
    where: { group_id_external_number: { group_id: args.groupId, external_number: ext } },
    create: {
      batch_id: args.batchId,
      group_id: args.groupId,
      external_number: ext,
      issue_date: p.issueDate,
      registration: p.registration,
      subtotal_printed: (p.subtotalPrinted ?? 0) as any,
      subtotal_parsed: r.parsed as any,
      reconciled: r.ok,
      vat_printed: (p.vatPrinted ?? null) as any,
      vat_computed: (vatComputed ?? null) as any,
      planned_start_at: p.issueDate, // defaults to the invoice date; operator may move it
      raw_text: args.text,
      lines: {
        create: billableLines(p).map((l, i) => ({
          position: i,
          description: l.description,
          continuation_text: l.continuation.length ? l.continuation.join('\n') : null,
          qty: l.qty as any,
          unit_price: l.unitPrice as any,
          vat_text: l.vatText || null,
          amount: l.amount as any,
          is_adjustment: l.isAdjustment,
          parts_cost: l.isAdjustment ? (0 as any) : null,
        })),
      },
    },
    update: {}, // idempotent: re-ingesting an already-staged invoice changes nothing
    select: { id: true, reconciled: true },
  });

  return { ok: true, id: staged.id, reconciled: staged.reconciled };
}

export async function batchTotals(batchId: string): Promise<BatchTotals> {
  const invs = await prisma.stagedInvoice.findMany({
    where: { batch_id: batchId },
    select: {
      status: true, reconciled: true, subtotal_parsed: true,
      vat_printed: true, vat_computed: true,
      lines: { select: { parts_cost: true, is_adjustment: true, kind: true } },
    },
  });

  const count = (s: string) => invs.filter((i: any) => i.status === s).length;
  const parsedNet = invs.reduce((a: number, i: any) => a + Math.round(Number(i.subtotal_parsed) * 100), 0);
  const committedNet = invs
    .filter((i: any) => i.status === 'committed')
    .reduce((a: number, i: any) => a + Math.round(Number(i.subtotal_parsed) * 100), 0);

  const vatVariances = invs.filter(
    (i: any) => i.vat_printed != null && i.vat_computed != null &&
      Math.abs(Number(i.vat_printed) - Number(i.vat_computed)) >= 0.005,
  ).length;

  const linesUncosted = invs.reduce(
    (a: number, i: any) => a + i.lines.filter((l: any) => !l.is_adjustment && l.parts_cost == null).length, 0,
  );

  return {
    invoices: {
      total: invs.length,
      pending: count('pending'),
      inProgress: count('in_progress'),
      committed: count('committed'),
      skipped: count('skipped'),
    },
    reconciliation: {
      reconciled: invs.filter((i: any) => i.reconciled).length,
      failed: invs.filter((i: any) => !i.reconciled).length,
    },
    money: {
      parsedNetPennies: parsedNet,
      committedNetPennies: committedNet,
      residualPennies: parsedNet - committedNet,
    },
    vatVariances,
    linesUncosted,
  };
}
