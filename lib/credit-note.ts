/**
 * File: lib/credit-note.ts
 * THE credit-note rules: when one is required, what it must contain, and how it is minted.
 *
 * ── THE ACCOUNTANT'S RULING (2026-08-16) ────────────────────────────────────────────────────────
 * Correcting a wrong figure on an ISSUED invoice requires a credit note plus a replacement, not an
 * amendment in place under the same number. And a refund needs a credit note: the refunded stamp
 * proves the payment EVENT but does not reverse output VAT, so every refund until now has left the
 * garage's VAT record overstated.
 *
 * Four concepts, not one: Invoice (immutable commercial charge), CreditNote (immutable VAT
 * correction, own sequence), Payment/Refund (money movement), and the management ledger.
 *
 * ── TWO CLOCKS, BOTH CORRECT ────────────────────────────────────────────────────────────────────
 * The CASH clock (lib/payments::receivedInPeriod) attributes a refund to the month the money left.
 * The VAT clock attributes the correction to the period of the credit note's own date. They are
 * EXPECTED to differ and neither is wrong — they answer different questions. This is why the date
 * is confirmed by a person rather than adopted from the refund: an automatic document silently
 * picks a tax point, and the visibility of that choice is the entire reason the clocks may differ.
 */
import type { Prisma } from '@prisma/client';
import { assignCreditNoteNumber, formatInvoiceNumber } from '@/lib/invoice-number';

export type CreditRefusal = { code: string; message: string };

// ── PREDICATE 1: IS THERE ANY OUTPUT VAT TO REVERSE? ─────────────────────────────────────────────
/**
 * STATED, not inferred from a where-clause somewhere else.
 *
 * Today no warranty or historical document can reach the VAT return, because every VAT read names
 * `series: 'chargeable'`. That makes the rule TRUE but UNFINDABLE — a reader of this file cannot
 * see it, and the day a fourth series appears the rule is silently wrong. So it is written here, as
 * the thing the rule actually depends on: was output tax declared on this document?
 *
 * NOTE THE ZERO-RATED CASE, which is the one real refund we have. TMBS invoice 100003210 was issued
 * by a VAT-REGISTERED tenant at 0% — so output TAX is nil, but the supply is still declared in net
 * outputs. `hasOutputVat` is false (nothing to reverse) while `isDeclaredSupply` is true, and the
 * two are kept apart deliberately: conflating them is how "no VAT" quietly becomes "not a sale".
 */
export function vatPosition(inv: {
  series: string;
  vat_registered_at_issue: boolean;
  lines: Array<{ line_vat: unknown; line_total: unknown }>;
}): { isDeclaredSupply: boolean; hasOutputVat: boolean; outputVatPennies: number; netPennies: number } {
  const p = (v: unknown) => Math.round(Number(v ?? 0) * 100);
  const outputVatPennies = inv.lines.reduce((a, l) => a + p(l.line_vat), 0);
  const netPennies = inv.lines.reduce((a, l) => a + p(l.line_total), 0);
  // A DECLARED SUPPLY is one the VAT return reports at all. Warranty settles at £0 goodwill and is
  // not a sale; historical records a document issued under a previous system and must never
  // re-declare tax already declared elsewhere.
  const isDeclaredSupply = inv.series === 'chargeable' && inv.vat_registered_at_issue;
  return { isDeclaredSupply, hasOutputVat: isDeclaredSupply && outputVatPennies > 0, outputVatPennies, netPennies };
}

/** Does this refund require a credit note? The stated rule, in one place. */
export function creditNoteRequired(inv: Parameters<typeof vatPosition>[0]): boolean {
  return vatPosition(inv).hasOutputVat;
}

// ── PREDICATE 2: THE CAP — AGAINST WHAT WAS INVOICED ─────────────────────────────────────────────
/**
 * DELIBERATELY NOT SHARED with lib/refund-eligibility::refuseManualAmount.
 *
 * That one caps refunds against WHAT WAS RECEIVED. This caps credit notes against WHAT WAS
 * INVOICED. On a part-paid invoice they differ; on an over-refunded goodwill case they differ the
 * other way. They usually agree, and that is precisely what would let a shared predicate survive
 * review while being wrong in the two cases that matter.
 */
export function refuseCreditAmount(
  invoicedPennies: number,
  alreadyCreditedPennies: number,
  amountPennies: number,
): CreditRefusal | null {
  if (!Number.isInteger(amountPennies) || amountPennies <= 0) {
    return { code: 'bad_amount', message: 'Enter the amount being credited, as an amount greater than zero.' };
  }
  const remaining = Math.max(0, invoicedPennies - alreadyCreditedPennies);
  if (remaining <= 0) {
    return { code: 'fully_credited', message: 'This invoice has already been credited in full.' };
  }
  if (amountPennies > remaining) {
    return {
      code: 'exceeds_invoiced',
      message: `That is more than remains on this invoice. At most ${(remaining / 100).toFixed(2)} can still be credited.`,
    };
  }
  return null;
}

// ── PREDICATE 3: CREDIT-NOTE-ONLY, OR CREDIT NOTE PLUS REPLACEMENT? ──────────────────────────────
/**
 * A pure DOWNWARD correction of a SETTLED invoice needs no replacement: the customer owes nothing,
 * and raising a replacement for money already received then allocating a payment against it is
 * machinery invented to satisfy a rule that does not apply.
 *
 * Everything else gets a replacement, because the customer still owes something and needs a
 * document to pay against.
 */
export type CorrectionShape = 'credit_only' | 'credit_and_replace';

export function correctionShape(args: {
  invoicedPennies: number;
  receivedPennies: number;
  correctedPennies: number;
}): CorrectionShape {
  const settled = args.receivedPennies >= args.invoicedPennies && args.invoicedPennies > 0;
  const purelyDownward = args.correctedPennies < args.invoicedPennies;
  return settled && purelyDownward ? 'credit_only' : 'credit_and_replace';
}

// ── PREDICATE 4: THE JOB CARD DOES NOT MOVE ──────────────────────────────────────────────────────
/**
 * Stated as a function so it is asserted rather than remembered. A credit note is a fact about a
 * DOCUMENT, not about the work — the same rule a refund follows. Nothing about issuing one changes
 * where the job is in the workshop.
 */
export const creditNoteMovesJobCard = (): false => false;

// ── THE MINT ─────────────────────────────────────────────────────────────────────────────────────
/**
 * Freeze-at-issue, exactly as an invoice does: its own number from its own counter, its own date,
 * and snapshot lines that are never recomputed.
 *
 * POSITIVE line amounts. The document's SIGN is carried by its type, not by negative numbers on the
 * rows — lib/vat-summary SUBTRACTS these. A negative qty on a line is how a reader double-negates.
 */
export async function mintCreditNote(tx: Prisma.TransactionClient, args: {
  groupId: string;
  invoiceId: string;
  /** THE VAT-CLOCK DATE. Confirmed by a person at the surface; never defaulted here. */
  dateIssued: Date;
  reason: string;
  refundId?: string | null;
  createdBy: string | null;
  /** Positive amounts, the same grain as InvoiceLine. */
  lines: Array<{
    position: number; description: string; item_type: string;
    qty: number; unit_price: number; vat_rate: number; line_total: number; line_vat: number;
  }>;
}): Promise<{ id: string; number: string }> {
  // TYPED, not `(…) as any`. The prisma-any ratchet caught this on its first outing against new
  // code, which is what it is for: a cast here would hide a forgotten select in the very query that
  // supplies a credit note's frozen particulars.
  const inv = await (tx as Prisma.TransactionClient).invoice.findUnique({
    where: { id: args.invoiceId },
    select: {
      id: true, group_id: true, site_id: true, vat_registered_at_issue: true,
      company_name_snapshot: true, company_vat_number_snapshot: true, company_address_snapshot: true,
      customer_name_snapshot: true, customer_address_snapshot: true,
      group: { select: { invoice_credit_note_prefix: true, invoice_pad_width: true, invoice_fy_digits: true, fy_start_month: true } },
    },
  });
  if (!inv) throw new Error('CREDIT_NOTE_INVOICE_NOT_FOUND');
  if (inv.group_id !== args.groupId) throw new Error('CREDIT_NOTE_WRONG_TENANT');
  if (!args.lines.length) throw new Error('CREDIT_NOTE_NO_LINES');
  if (!args.reason?.trim()) throw new Error('CREDIT_NOTE_NO_REASON');

  const seq = await assignCreditNoteNumber(tx, args.groupId);
  const number = formatInvoiceNumber(
    {
      prefix: inv.group.invoice_credit_note_prefix,
      padWidth: inv.group.invoice_pad_width,
      fyDigits: inv.group.invoice_fy_digits,
      fyStartMonth: inv.group.fy_start_month,
      issuedAt: args.dateIssued,
    },
    seq,
  );

  const row = await (tx as Prisma.TransactionClient).creditNote.create({
    data: {
      group_id: args.groupId, site_id: inv.site_id, invoice_id: inv.id,
      sequence_value: seq, credit_note_number: number,
      date_issued: args.dateIssued,
      reason: args.reason.trim().slice(0, 500),
      refund_id: args.refundId ?? null,
      // SNAPSHOTTED FROM THE INVOICE, not re-resolved from the tenant today: a credit note must
      // carry the same company and customer particulars as the document it corrects, or the pair
      // does not read as a pair.
      vat_registered_at_issue: inv.vat_registered_at_issue,
      company_name_snapshot: inv.company_name_snapshot,
      company_vat_number_snapshot: inv.company_vat_number_snapshot,
      company_address_snapshot: inv.company_address_snapshot,
      customer_name_snapshot: inv.customer_name_snapshot,
      customer_address_snapshot: inv.customer_address_snapshot,
      created_by: args.createdBy,
      lines: { create: args.lines.map((l) => ({ ...l, item_type: l.item_type as never })) },
    },
    select: { id: true, credit_note_number: true },
  });
  return { id: row.id, number: row.credit_note_number };
}
