/**
 * File: scripts/goldens-june.mjs
 * READ-ONLY. The June-2026 TMBS ledger golden — the reference figure every money-touching slice
 * asserts before and after.
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
import crypto from 'crypto';

const prisma = new PrismaClient();
const TMBS = '854d38e7-6dd4-4836-af61-a0d169639a78';

const INVOICE_FIELDS = {
  sequence_value: true, invoice_number: true, series: true, status: true,
  date_issued: true, date_paid: true,
  is_imported: true, external_ref: true,
  vat_registered_at_issue: true, company_vat_number_snapshot: true, company_name_snapshot: true,
  customer_name_snapshot: true, vehicle_reg_snapshot: true,
};
const LINE_FIELDS = {
  position: true, description: true, item_type: true,
  qty: true, unit_price: true, unit_cost: true, vat_rate: true,
  line_total: true, line_vat: true,
  labour_hours: true, labour_outsourced: true,
};

const invoices = await prisma.invoice.findMany({
  where: { group_id: TMBS, date_issued: { gte: new Date('2026-06-01'), lt: new Date('2026-07-01') } },
  orderBy: [{ series: 'asc' }, { sequence_value: 'asc' }],
  select: { ...INVOICE_FIELDS, lines: { select: LINE_FIELDS, orderBy: [{ position: 'asc' }, { description: 'asc' }] } },
});

const lineCount = invoices.reduce((n, i) => n + i.lines.length, 0);
const money = invoices.reduce((n, i) => n + i.lines.reduce((m, l) => m + Number(l.line_total) + Number(l.line_vat), 0), 0);

console.log('invoices:', invoices.length, 'lines:', lineCount, 'gross: £' + money.toFixed(2));
console.log('sha256:', crypto.createHash('sha256').update(JSON.stringify(invoices)).digest('hex'));
await prisma.$disconnect();
