/**
 * File: scripts/goldens-june.mjs
 * READ-ONLY. The June-2026 TMBS ledger golden — the reference figure every money-touching slice
 * asserts before and after.
 *
 * ── WHAT THIS GOLDEN DOES NOT PROTECT ───────────────────────────────────────────────────────────
 * IT WILL NOT CATCH A REFUND MIS-DATED INTO A CLOSED PERIOD. The hash is DOCUMENT-shaped —
 * sequence, number, series, status, date_issued, date_paid, the snapshots and the frozen lines. A
 * refund is LEDGER-shaped: it writes a Refund row and moves Invoice.amount_paid_pennies, and
 * NEITHER is hashed here. A refund deliberately leaves status at `paid` and never touches
 * date_paid, so there is no hashed field it can reach.
 *
 * That is correct — this golden exists to prove the DOCUMENTS have not moved, and they have not.
 * But it means a £500 refund back-dated into June 2026 would change what June earned and this
 * would still print f150133f. Anyone treating a green golden as "the June figures are untouched"
 * is reading more into it than it says.
 *
 * Verified rather than assumed (2026-08-16): TMBS has 46 June-2026 invoices and zero refunds
 * against any of them; one Refund row exists in the entire database. So refunds becoming
 * first-class is safe for this hash BY CONSTRUCTION, not by luck — and stays safe.
 *
 * A closed-period guard would be its own thing, and whether one is wanted is an accountant
 * question rather than an engineering one. It is on the list going to them alongside the
 * credit-note question and the fee VAT treatment.
 *
 * ── WHY THIS IS AN EXPLICIT COLUMN LIST ─────────────────────────────────────────────────────────
 * The previous version did `include: { lines: true }` and hashed EVERY column. That made the hash a
 * function of the TABLE SHAPE as well as the data, so adding four unrelated nullable columns
 * (voided_at, voided_by, void_category, void_reason) moved it from bce39640… to 50d35879… with the
 * ledger untouched — a false alarm that cost real time to disprove, and one that would recur on
 * every future column.
 *
 * A golden must move when the LEDGER moves and at no other time. So the fields below are pinned by
 * name: the money, the tax, the dates that bucket it, the identity that prints on it, and the
 * status that decides whether it counts. Adding a column to Invoice no longer touches this hash.
 * Adding a column that BEARS MONEY should be added here deliberately, which is the point.
 *
 * Deliberately EXCLUDED and why:
 *   id / job_card_id / site_id / group_id  — surrogate keys; identity is sequence_value + series
 *   created_at, issued_at                  — wall-clock of the write, not the document's date
 *                                            (date_issued is the ledger fact; issued_at is when
 *                                            someone happened to press the button)
 *   void_* / paid grain beyond date_paid   — process metadata; `status` already captures whether
 *                                            the row counts, and the void columns are only ever
 *                                            populated on rows `status` has already excluded
 *   line id / invoice_id                   — surrogate; position + description order the lines
 */
import { PrismaClient } from '@prisma/client';
import { juneGolden } from './_june-golden.mjs';

// THE COMPUTATION MOVED to scripts/_june-golden.mjs so the nightly backup verification can hash a
// RESTORED copy with the same field list. Two copies of that list would drift, which is the failure
// this golden exists to catch. This script stays the way a person runs it by hand.
const prisma = new PrismaClient();
const g = await juneGolden(prisma);
console.log('invoices:', g.invoices, 'lines:', g.lines, 'gross: £' + (g.grossPence / 100).toFixed(2));
console.log('sha256:', g.sha256);
await prisma.$disconnect();
