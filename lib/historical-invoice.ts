/**
 * File: lib/historical-invoice.ts
 * THE rules for recording an invoice that was issued under a PREVIOUS system.
 * Pure — no prisma, no session — so the endpoint, the screen and the gate read one decision.
 *
 * ── WHAT A HISTORICAL ENTRY IS ──────────────────────────────────────────────────────────────────
 * A record, not a document. The customer holds the ORIGINAL, carrying the old system's number,
 * which is kept verbatim in `external_ref`. The entry exists so the dashboard, the P&L and the
 * capacity figures can see months that predate GreaseDesk. It therefore:
 *   • draws its own number from the HISTORICAL counter — never the chargeable one
 *   • is EXCLUDED from the VAT return by construction (every VAT read names `series:'chargeable'`),
 *     because that output tax was declared under the old system and must not be declared twice
 *   • can never be emailed — there is no version of "send this to the customer" that is honest
 *   • appears in the ledger and P&L, which is the entire point of entering it
 *
 * ── THE MARKER IS WRITTEN AT ENTRY TIME, AND THAT IS THE POINT ──────────────────────────────────
 * 177 TMBS invoices were hand-keyed through the live workflow before this existed. Nothing on
 * those rows says what they are: `is_imported` is false, `external_ref` is null, and the
 * back-dating gap is a smooth continuum with no safe threshold — two candidate markers disagreed
 * on 24 of 179 rows, and 8 genuinely live invoices had their dates corrected by a day or two,
 * which any date-based rule would misread as historical and silently drop from a VAT return.
 * A marker cannot be recovered after the fact. It has to be recorded as it happens, here.
 */

export type HistoricalLineInput = {
  position: number;
  description: string;
  qty: number;
  unitPrice: number;
  vatRate: number;
  amount: number;
  kind: 'labour' | 'part' | 'misc' | 'fixed';
  labourHours: number | null;
  partsCost: number | null;
  costBasis: 'actual' | 'estimated' | null;
};

export type HistoricalInput = {
  externalRef: string;
  dateIssued: string;      // yyyy-mm-dd — the PRINTED date, immutable
  registration: string;
  customerName: string;
  subtotalPrinted: number;
  vatPrinted: number | null;
  totalPrinted: number | null;
  lines: HistoricalLineInput[];
  paymentMethodId: string | null;
  datePaid: string | null; // BLANK unless the operator knows it — never defaulted (see below)
  rawText: string;
};

export const RECONCILE_TOLERANCE = 0.005;

/**
 * A GreaseDesk-generated PDF must be refused as a whole, not surfaced as a blank form. Two
 * independent signals, because either alone could be a bad parse of a real source invoice:
 * no external number AND nothing that reconciles.
 */
export function looksLikeSourceInvoice(p: { externalNumber: string | null; lines: unknown[]; subtotalPrinted: number | null }): boolean {
  return !!p.externalNumber && p.lines.length > 0 && p.subtotalPrinted != null;
}

/** Sum of priced lines must equal the invoice's OWN printed subtotal. The parser is not the proof —
 *  the document is. This is the same gate the original import path enforced. */
export function reconciles(lines: Array<{ amount: number }>, subtotalPrinted: number): { ok: boolean; parsed: number; diff: number } {
  const parsed = Math.round(lines.reduce((a, l) => a + l.amount, 0) * 100) / 100;
  const diff = Math.round((parsed - subtotalPrinted) * 100) / 100;
  return { ok: Math.abs(diff) < RECONCILE_TOLERANCE, parsed, diff };
}

export type Refusal = { code: string; message: string };

/**
 * ── LABOUR HOURS ARE NOT OPTIONAL ON A LABOUR LINE ──────────────────────────────────────────────
 * They are the utilisation DENOMINATOR. A labour line saved with null hours produces revenue with
 * no hours behind it, which silently flatters every efficiency figure for that month — and it is
 * the field an operator working through a stack of PDFs is most likely to skip, because the
 * document does not carry it. So it is refused at the door rather than flagged afterwards.
 */
export function validateHistorical(input: HistoricalInput): Refusal | null {
  if (!input.externalRef?.trim()) return { code: 'no_number', message: 'The original invoice number is missing. It is the one thing this record exists to keep.' };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.dateIssued || '')) return { code: 'bad_date', message: 'Enter the date printed on the invoice.' };
  if (!input.registration?.trim()) return { code: 'no_reg', message: 'A registration is needed — the vehicle is how this record finds its customer.' };
  if (!input.customerName?.trim()) return { code: 'no_customer', message: 'Enter the customer name. The parsed name is a suggestion — 38% of these invoices carry only a first name.' };
  if (!input.lines.length) return { code: 'no_lines', message: 'No lines were read from this invoice.' };

  const missingHours = input.lines.filter((l) => l.kind === 'labour' && (l.labourHours == null || !(l.labourHours > 0)));
  if (missingHours.length) {
    return {
      code: 'labour_hours_missing',
      message: `Labour hours are needed on ${missingHours.length} line(s): ${missingHours.map((l) => l.description.slice(0, 40)).join('; ')}. They are the denominator every utilisation figure divides by — a labour line without them reports revenue against no time.`,
    };
  }
  const r = reconciles(input.lines, input.subtotalPrinted);
  if (!r.ok) {
    return { code: 'no_reconcile', message: `The lines total ${r.parsed.toFixed(2)} but the invoice prints ${input.subtotalPrinted.toFixed(2)} (out by ${r.diff.toFixed(2)}). Fix the lines to match the document — the document is right.` };
  }
  // A paid date is OPTIONAL and must stay blank when unknown. Defaulting it to the issue date
  // would invent a cash-basis fact the document does not state.
  if (input.datePaid && !/^\d{4}-\d{2}-\d{2}$/.test(input.datePaid)) return { code: 'bad_paid_date', message: 'Enter a valid paid date, or leave it blank.' };
  return null;
}

/**
 * THE send guard. There is no honest version of emailing a historical record: the customer already
 * has the original, under a different number, from a system we no longer run. Same one-predicate
 * shape as refuseIfVoid so a new send path cannot be added that forgets it.
 */
export function refuseIfHistorical(inv: { series: string } | null | undefined): Refusal | null {
  if (inv?.series !== 'historical') return null;
  return { code: 'historical', message: 'This is a record of an invoice issued under your previous system, not a document to send. The customer already has the original.' };
}

/** Candidate match for the supersede offer: same vehicle, same document date, same gross. */
export type SupersedeCandidate = { id: string; invoiceNumber: string; datePaid: string | null; grossPennies: number };
