/**
 * File: scripts/_june-golden.mjs
 * THE JUNE-2026 TMBS LEDGER GOLDEN, in one place.
 *
 * The field lists and the hash used to live only in scripts/goldens-june.mjs. The nightly backup
 * verification needs the SAME hash computed against a RESTORED copy — and a second copy of the field
 * list would drift the first time either changed, which is the failure the golden exists to catch.
 * So the computation lives here and both callers import it.
 *
 * WHAT THE HASH COVERS, and what it does not: the documents — sequence, number, series, status, the
 * dates that bucket them, the snapshots that print on them, and the frozen lines. NOT the ledger
 * movements: a refund writes a Refund row and moves amount_paid_pennies, and neither is hashed here.
 * A green hash says the June DOCUMENTS have not moved; it does not say June earned what it earned.
 */
import crypto from 'node:crypto';

export const TMBS_GROUP_ID = '854d38e7-6dd4-4836-af61-a0d169639a78';
export const JUNE_FROM = new Date('2026-06-01');
export const JUNE_TO = new Date('2026-07-01');

export const INVOICE_FIELDS = {
  sequence_value: true, invoice_number: true, series: true, status: true,
  date_issued: true, date_paid: true,
  is_imported: true, external_ref: true,
  vat_registered_at_issue: true, company_vat_number_snapshot: true, company_name_snapshot: true,
  customer_name_snapshot: true, vehicle_reg_snapshot: true,
};
export const LINE_FIELDS = {
  position: true, description: true, item_type: true,
  qty: true, unit_price: true, unit_cost: true, vat_rate: true,
  line_total: true, line_vat: true,
  labour_hours: true, labour_outsourced: true,
};

/** Reads June 2026 from whichever database the client points at, and hashes it. */
export async function juneGolden(prisma) {
  const invoices = await prisma.invoice.findMany({
    where: { group_id: TMBS_GROUP_ID, date_issued: { gte: JUNE_FROM, lt: JUNE_TO } },
    orderBy: [{ series: 'asc' }, { sequence_value: 'asc' }],
    select: { ...INVOICE_FIELDS, lines: { select: LINE_FIELDS, orderBy: [{ position: 'asc' }, { description: 'asc' }] } },
  });
  const lines = invoices.reduce((n, i) => n + i.lines.length, 0);
  const grossPence = invoices.reduce((n, i) => n + i.lines.reduce((m, l) => m + Math.round(Number(l.line_total) * 100) + Math.round(Number(l.line_vat) * 100), 0), 0);
  return {
    invoices: invoices.length,
    lines,
    grossPence,
    sha256: crypto.createHash('sha256').update(JSON.stringify(invoices)).digest('hex'),
  };
}
