/**
 * File: lib/import-assert.ts
 * THE post-write assertion for an imported invoice: what is IN STORAGE must equal what the source
 * document printed.
 *
 * WHY THIS EXISTS. The reconciliation gate compares the PARSED lines against the printed Subtotal —
 * it is a check on the parse, and it passes before a single ledger row is written. Every defect
 * found on 2026-07-20 landed after it, in the commit path: VAT frozen at zero on six of seven
 * invoices, a £1,537.37 credit dropped, and a split that lost a penny to a 2-dp column. All seven
 * reconciled. A gate that never reads what was written cannot see any of that.
 *
 * So this re-reads the InvoiceLine rows FROM THE DATABASE — never the objects the caller just built,
 * which is the whole point: the objects are what the code believes, the rows are what it did.
 *
 * EVERY re-freeze must satisfy it, not just the mint. 100002297 was CORRECT at mint and was broken
 * afterwards by unlock → estimate re-save → re-freeze at paid; an assertion that fired only on the
 * first write would have watched that happen. Keyed on external_ref: an imported invoice must equal
 * its source document every single time its lines are frozen.
 */
import type { Prisma } from '@prisma/client';

export type ImportAssertResult = {
  ok: boolean;
  reasons: string[];
  written: { lines: number; subtotalPennies: number; vatPennies: number; totalPennies: number };
  printed: { lines: number | null; subtotalPennies: number | null; vatPennies: number | null; totalPennies: number | null };
};

const pennies = (v: unknown): number => Math.round(Number(v ?? 0) * 100);
const money = (p: number) => `£${(p / 100).toFixed(2)}`;

/**
 * Compare the WRITTEN lines of `invoiceId` against the printed figures of the staged invoice with
 * `externalRef`. Returns ok:false with human reasons; the caller throws to roll its transaction back.
 *
 * A printed figure that was never captured (legacy rows predating total_printed) is SKIPPED rather
 * than defaulted — an absent comparison is honest, an invented one is not.
 */
export async function assertImportedInvoiceMatchesSource(
  tx: Prisma.TransactionClient,
  args: { invoiceId: string; groupId: string; externalRef: string },
): Promise<ImportAssertResult> {
  const [lines, staged] = await Promise.all([
    tx.invoiceLine.findMany({
      where: { invoice_id: args.invoiceId },
      select: { line_total: true, line_vat: true },
    }),
    tx.stagedInvoice.findFirst({
      where: { group_id: args.groupId, external_number: args.externalRef },
      select: {
        subtotal_printed: true, vat_printed: true, total_printed: true,
        lines: { where: { parent_line_id: null }, select: { id: true } },
        // Split parents are REPLACED by their children at commit, so the comparable count is
        // (top-level lines − split parents) + children.
        _count: { select: { lines: true } },
      },
    }),
  ]);

  const written = {
    lines: lines.length,
    subtotalPennies: lines.reduce((a, l) => a + pennies(l.line_total), 0),
    vatPennies: lines.reduce((a, l) => a + pennies(l.line_vat), 0),
    totalPennies: 0,
  };
  written.totalPennies = written.subtotalPennies + written.vatPennies;

  const printed = {
    lines: null as number | null,
    subtotalPennies: staged?.subtotal_printed == null ? null : pennies(staged.subtotal_printed),
    vatPennies: staged?.vat_printed == null ? null : pennies(staged.vat_printed),
    totalPennies: staged?.total_printed == null ? null : pennies(staged.total_printed),
  };

  const reasons: string[] = [];
  if (!staged) {
    // No source to compare against: report it rather than passing silently.
    return { ok: false, reasons: [`no staged invoice found for external ref ${args.externalRef}`], written, printed };
  }
  if (printed.subtotalPennies != null && written.subtotalPennies !== printed.subtotalPennies) {
    reasons.push(`subtotal written ${money(written.subtotalPennies)} but the invoice prints ${money(printed.subtotalPennies)}`);
  }
  if (printed.vatPennies != null && written.vatPennies !== printed.vatPennies) {
    reasons.push(`VAT written ${money(written.vatPennies)} but the invoice prints ${money(printed.vatPennies)}`);
  }
  if (printed.totalPennies != null && written.totalPennies !== printed.totalPennies) {
    reasons.push(`total written ${money(written.totalPennies)} but the invoice prints ${money(printed.totalPennies)}`);
  }
  if (written.lines === 0) reasons.push('no lines were written');

  return { ok: reasons.length === 0, reasons, written, printed };
}

/** The refusal message a caller throws. Prefixed so the API can surface it as a 409, not a 500. */
export function importAssertError(externalRef: string, r: ImportAssertResult): Error {
  return new Error(
    `IMPORT_ASSERT:Invoice ${externalRef} was NOT committed — what would have been written does not ` +
    `match the source document: ${r.reasons.join('; ')}. Nothing was saved.`,
  );
}
