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
 *
 * ── THE RULING THAT SETTLED IT (2026-09-05): UNLOCK MAKES A DOCUMENT PROVISIONAL ────────────────
 * A third policy lived here briefly — `correctable`, an explicit admin-only correction of the
 * addressee — and it is gone, because the question it answered turned out to be the wrong one.
 *
 * An invoice is issued when it is PRESENTED and becomes a record when it is PAID. Unlocking an
 * unpaid document therefore makes it provisional again, and a re-issue rebuilds its SUBJECT from
 * what is true now — the same way it already rebuilt the lines and the advisory block. History is
 * protected by payment, not by issue.
 *
 * That was never a new idea: lib/invoice-doc has rendered the vehicle block live while unpaid and
 * frozen once paid since the beginning, calling it "the deliberate asymmetry", and
 * lib/invoice-void::amendmentRequirement already says "PAID IS NOT A STATUS ANY MORE — it is a
 * payment record". Freeze-at-issue contradicted both. This register is where the contradiction was
 * written down, so this is where it is resolved.
 *
 * ── WHICH LEAVES TWO KINDS OF FROZEN, AND ONLY ONE ARGUMENT ─────────────────────────────────────
 * What stays frozen is not "the past" but the ISSUING ENTITY and the PAYMENT: who raised the
 * document and how money arrived. What rebuilds is the document's SUBJECT: who is billed and for
 * which car. A garage correcting an unpaid invoice is not restating history — the document has not
 * become history yet.
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
  // ── REBUILD: THE PARTY, WHICH IS THE DOCUMENT'S SUBJECT ──────────────────────────────────────
  // Who is billed, and where. Rebuilt from the customer record at re-issue, which is what makes
  // "bill this one to their employer" a thing a garage can do to an unpaid invoice: set the account
  // on the customer, re-issue, done. A dedicated correction endpoint existed for two days to do
  // exactly this and was deleted, because editing the customer and pressing the button people
  // already press is a better answer than a second way to change the same four columns.
  { column: 'customer_name_snapshot', policy: 'rebuild' },
  { column: 'customer_address_snapshot', policy: 'rebuild' },
  { column: 'account_name_snapshot', policy: 'rebuild' },
  { column: 'account_address_snapshot', policy: 'rebuild' },

  { column: 'vat_registered_at_issue', policy: 'frozen',
    reason: 'whether VAT was chargeable then; a later registration cannot make past VAT due. NOT merely descriptive: snapshotInvoiceLines reads it to decide the tax when the lines re-freeze, so rebuilding it would let a re-issue move the money' },

  // ── FROZEN: THE PAYMENT, WHICH IS ITS OWN EVENT ──────────────────────────────────────────────
  { column: 'payment_method_snapshot', policy: 'frozen',
    reason: 'how it was actually paid; renaming a payment method never rewrites how money arrived' },

  // ── REBUILD: THE CAR, WHICH IS A FACT THAT CAN BE CORRECTED ──────────────────────────────────
  // Declared `rebuild` since this register existed, and until 2026-09-05 re-snapshotted only on the
  // MARK-PAID path — so the declaration promised something the re-issue did not do. The code now
  // matches: the re-issue rebuilds them, and mark-paid still freezes them at the moment the
  // document becomes a record. A mistyped registration is a mistake to fix, not a fact to preserve.
  { column: 'vehicle_reg_snapshot', policy: 'rebuild' },
  { column: 'vehicle_vin_snapshot', policy: 'rebuild' },
  { column: 'vehicle_mileage_snapshot', policy: 'rebuild' },
  // REVISITED WITH ITS THREE SIBLINGS, as its old reason asked for. It was frozen only because
  // freezeVehicleFacts did not happen to touch it; nobody ever argued the case.
  { column: 'vehicle_desc_snapshot', policy: 'rebuild' },

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

/**
 * The columns a re-issue must write. The gate checks the re-issue path against exactly this — and,
 * separately, that it writes NOTHING outside it: `frozen` and `correctable` are both excluded here,
 * and for the same reason. A correction is an act somebody performs, never a thing that happens
 * because a different button was pressed.
 */
export const REBUILT_ON_REISSUE: readonly string[] =
  INVOICE_SNAPSHOTS.filter((s) => s.policy === 'rebuild').map((s) => s.column);
