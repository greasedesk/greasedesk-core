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
 * ── AND A THIRD, ADDED 2026-09-03, WHICH IS ON A DIFFERENT AXIS ──────────────────────────────────
 *   correctable — a matter of record, like a frozen column: re-reading it from the source would
 *                 restate history, and it must never move as a side effect of anything, a re-issue
 *                 included. But the record can be WRONG in a way no other document can fix — an
 *                 invoice addressed to the wrong party is a mistake, not a fact — and there is no
 *                 second document that carries the correction. So it moves only by an explicit,
 *                 audited, admin-only action, only while the invoice is under correction, and every
 *                 one names in `via` the single path allowed to write it.
 *
 * Note the two policies answer different questions. `rebuild` and `frozen` describe what a RE-ISSUE
 * does automatically; `correctable` describes who may write it DELIBERATELY, and its answer to the
 * re-issue question is the same as `frozen`'s — nothing. That is why REBUILT_ON_REISSUE is derived
 * from `policy === 'rebuild'` and the gate's re-issue check selects `policy !== 'rebuild'`: written
 * the other way round, adding this policy would have made that check pass by covering less.
 *
 * A `correctable` entry costs TWO sentences: why not `rebuild` (the thing that distinguishes it),
 * and which endpoint may write it. A door in a freeze that nobody can point at is an unlock.
 */

export type SnapshotPolicy =
  | { column: string; policy: 'rebuild' }
  | { column: string; policy: 'frozen'; reason: string }
  | { column: string; policy: 'correctable'; reason: string; via: string };

/**
 * THE ONE PATH ALLOWED TO WRITE A CORRECTABLE COLUMN. Named here, once, so the register and the
 * gate that enforces it cannot disagree about which endpoint the exception belongs to.
 */
export const ADDRESSEE_PATH = 'pages/api/invoice-addressee.ts';

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
  // ── CORRECTABLE: THE ADDRESSEE BLOCK, ALL FOUR TOGETHER ──────────────────────────────────────
  // These four ARE the bill-to on the page. They move as one or the correction endpoint can write
  // two of the four fields it renders — half an addressee, which is neither the old party nor the
  // new one. Their reasons all answer the same two questions: why not rebuild, and why not frozen.
  { column: 'customer_name_snapshot', policy: 'correctable', via: ADDRESSEE_PATH,
    reason: 'NOT rebuild: a customer who has since married or moved was still billed under the name they were billed under, and re-reading the record would reprint history under a name that did not receive the document. NOT frozen: an invoice addressed to the wrong party is a mistake and nothing else can carry the fix — a garage billing an employer had no path at all and was told to void a valid document.' },
  { column: 'customer_address_snapshot', policy: 'correctable', via: ADDRESSEE_PATH,
    reason: 'NOT rebuild: where the document was addressed is a fact about the document, not a view of where the customer lives today. NOT frozen: a document sent to the wrong address must be re-addressable without retiring its number.' },
  // ── THE ACCOUNT, WHEN THE BILL IS NOT THE CAR OWNER'S ────────────────────────────────────────
  // The same party, said the other way round: these carry the employer/lease company an invoice was
  // addressed to, and the customer pair above carries whose car it was. Declared `frozen` on the
  // same grounds — a re-issue must not re-read the account from the customer record, because a
  // fleet put on account next year did not receive last year's invoices.
  //
  // FROZEN IS TRUE TODAY AND IS NOT THE FINAL ANSWER. Nothing can correct a document addressed to
  // the wrong party, which is the gap that produced this pair in the first place; slice two moves
  // this and the customer pair together to a third policy (`correctable`) — an explicit, audited,
  // admin-only correction while the invoice is under correction. Recorded here so the next reader
  // finds the pending decision beside the entry rather than in a report.
  { column: 'account_name_snapshot', policy: 'correctable', via: ADDRESSEE_PATH,
    reason: 'NOT rebuild: re-reading the account from the customer record would re-address a historical document to a party that was not billed then — a fleet put on account next year did not receive last year\'s invoices. NOT frozen: this pair exists precisely because a bill can go to the wrong party, and freezing it would leave the case it was built for unanswerable one invoice too late.' },
  { column: 'account_address_snapshot', policy: 'correctable', via: ADDRESSEE_PATH,
    reason: 'NOT rebuild: where that account was billed at issue. NOT frozen: it is corrected with the name it belongs to, never separately.' },
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

/**
 * The columns a re-issue must write. The gate checks the re-issue path against exactly this — and,
 * separately, that it writes NOTHING outside it: `frozen` and `correctable` are both excluded here,
 * and for the same reason. A correction is an act somebody performs, never a thing that happens
 * because a different button was pressed.
 */
export const REBUILT_ON_REISSUE: readonly string[] =
  INVOICE_SNAPSHOTS.filter((s) => s.policy === 'rebuild').map((s) => s.column);
