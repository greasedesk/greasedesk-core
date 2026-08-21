/**
 * File: lib/invoice-snapshots.ts
 * EVERY SNAPSHOT COLUMN ON Invoice, AND WHETHER A RE-ISSUE REBUILDS IT.
 *
 * ── WHY THIS REGISTER EXISTS ────────────────────────────────────────────────────────────────────
 * Twice now, part of a document has failed to move while the button reported success:
 *
 *   · invoice 100003203 survived four unlock/re-issue cycles still missing £75, because the
 *     docstring said re-issue re-snapshots "the corrected card lines" and the code resolved the
 *     accepted quote version instead;
 *   · invoice 100003222 was corrected an hour after issue and kept the tyre depths and the open
 *     advisories it had been wrong about, because due_items_snapshot had exactly one writer — the
 *     original mint — and re-issue never called it.
 *
 * Both are the same defect: a column captured at mint with nobody having decided what a RE-issue
 * should do with it. There are fourteen such columns and, before this file, the answer was written
 * down for none of them. So each one is declared here, and the gate refuses a column that is not.
 *
 * ── THE TWO ANSWERS, AND WHY BOTH ARE LEGITIMATE ────────────────────────────────────────────────
 *   rebuild  — the column describes something that can be CORRECTED, and correcting the document
 *              is what a re-issue is for. Rebuilt from what is true now, and the screen says so.
 *   frozen   — the column records what was true AT ISSUE as a matter of record, and rebuilding it
 *              would rewrite history rather than correct it. Every one carries its reason.
 *
 * A `frozen` entry is a decision, not a default. The reason is required, and it must say what
 * would be WRONG about rebuilding — not merely that it is not rebuilt today.
 */

export type SnapshotPolicy =
  | { column: string; policy: 'rebuild' }
  | { column: string; policy: 'frozen'; reason: string };

export const INVOICE_SNAPSHOTS: readonly SnapshotPolicy[] = [
  // ── FROZEN: THE PARTIES, AS THEY WERE ────────────────────────────────────────────────────────
  // A document is a record of a transaction between two named parties on a date. Rebuilding these
  // would restate a past transaction in the present's terms — the garage that traded then is who
  // the customer dealt with, whatever it renamed itself to since.
  { column: 'company_name_snapshot', policy: 'frozen',
    reason: 'the legal entity that issued the document; a later rename did not issue it' },
  { column: 'company_vat_number_snapshot', policy: 'frozen',
    reason: 'the VAT number the tax was declared under; rebuilding would misstate a filed return' },
  { column: 'company_address_snapshot', policy: 'frozen',
    reason: 'where the business traded from at issue' },
  { column: 'company_trading_name_snapshot', policy: 'frozen',
    reason: 'the name over the door on the day, and 1085 of 3395 documents pre-date the column — see trading-name-gate' },
  { column: 'customer_name_snapshot', policy: 'frozen',
    reason: 'who was billed; a customer who has since married or moved was still billed under that name' },
  { column: 'customer_address_snapshot', policy: 'frozen',
    reason: 'where the document was addressed' },
  { column: 'vat_registered_at_issue', policy: 'frozen',
    reason: 'whether VAT was chargeable then; a later registration cannot make past VAT due' },

  // ── FROZEN: THE PAYMENT, WHICH IS ITS OWN EVENT ──────────────────────────────────────────────
  { column: 'payment_method_snapshot', policy: 'frozen',
    reason: 'how it was actually paid; renaming a payment method never rewrites how money arrived' },

  // ── REBUILD: THE CAR, WHICH IS A FACT THAT CAN BE CORRECTED ──────────────────────────────────
  // These already re-snapshot on the mark-paid path (snapshotInvoiceLines, freezeVehicleFacts) —
  // the DELIBERATE ASYMMETRY documented there: money freezes at issue, identity facts stay live
  // while the document is still editable. A mistyped registration is a mistake to fix, not a
  // historical fact to preserve.
  { column: 'vehicle_reg_snapshot', policy: 'rebuild' },
  { column: 'vehicle_vin_snapshot', policy: 'rebuild' },
  { column: 'vehicle_mileage_snapshot', policy: 'rebuild' },
  { column: 'vehicle_desc_snapshot', policy: 'frozen',
    reason: 'NOT re-snapshotted by freezeVehicleFacts today, unlike the other three — declared frozen because that is what the code does, not because anyone argued for it. Worth revisiting with reg/VIN/mileage, together.' },

  // ── REBUILD: WHAT THE CAR NEEDS, AND WHAT THE VISIT SORTED ───────────────────────────────────
  // The reason this register exists. Rebuilt from what is true NOW — which is right for the case
  // a re-issue is actually used for, and a real change when it happens months later. Named on the
  // re-issue control rather than discovered afterwards.
  { column: 'due_items_snapshot', policy: 'rebuild' },
  { column: 'measured_snapshot', policy: 'rebuild' },
  { column: 'work_done_snapshot', policy: 'rebuild' },
];

export const snapshotPolicy = (column: string): SnapshotPolicy | undefined =>
  INVOICE_SNAPSHOTS.find((s) => s.column === column);

/** The columns a re-issue must write. The gate checks the re-issue path against exactly this. */
export const REBUILT_ON_REISSUE: readonly string[] =
  INVOICE_SNAPSHOTS.filter((s) => s.policy === 'rebuild').map((s) => s.column);
