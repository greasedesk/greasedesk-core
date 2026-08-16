/**
 * File: scripts/credit-note-backlog.mjs
 * WHICH REFUNDS STILL NEED A CREDIT NOTE. Read-only. Run it; do not reconstruct it.
 *
 * ── WHY THIS EXISTS AS A SCRIPT AND NOT A NOTE ──────────────────────────────────────────────────
 * Credit notes ship after refunds did. Anything refunded in between leaves the garage's VAT record
 * overstated until a correction is issued, and "we'll work out which ones later" is an archaeology
 * exercise that gets more expensive every day. The owner's instruction (2026-08-16) was to keep the
 * list somewhere it can be ANSWERED FROM rather than reconstructed. This is that place.
 *
 * ── THE RULE IT APPLIES ─────────────────────────────────────────────────────────────────────────
 *   NEEDED   — the refunded invoice carried NON-ZERO output VAT and has no credit note covering it.
 *   LISTED   — zero-rated or £0-VAT: there is no tax to reverse, so none is issued. But it is
 *              REPORTED rather than dropped, because a zero-rated supply is still declared in net
 *              outputs and the question "why is the period £50 high" must be answerable.
 *   N/A      — warranty (£0 goodwill, not a sale) or historical (declared under a previous system),
 *              or an unregistered tenant. Nothing was declared, so nothing can be overstated.
 *
 * The classification comes from lib/credit-note::vatPosition — the same predicate the product uses,
 * not a copy of it. A backlog report that disagrees with the code is worse than no report.
 */
import './_gate-preflight.mjs';
import './_ts.mjs';
const { prisma } = await import('../lib/db.ts');
const { vatPosition } = await import('../lib/credit-note.ts');

const P = (p) => `£${(p / 100).toFixed(2)}`;

const refunds = await prisma.refund.findMany({
  orderBy: { collected_at: 'asc' },
  select: {
    id: true, amount_pennies: true, collected_at: true, reason: true,
    payment: {
      select: {
        provider: true,
        invoice: {
          select: {
            id: true, invoice_number: true, series: true, vat_registered_at_issue: true,
            group: { select: { ref: true, group_name: true } },
            lines: { select: { line_total: true, line_vat: true } },
            credit_notes: { select: { id: true, credit_note_number: true, date_issued: true } },
          },
        },
      },
    },
  },
});

const rows = refunds.map((r) => {
  const inv = r.payment?.invoice;
  if (!inv) return { r, state: 'ORPHAN', why: 'the refund names no invoice' };
  const v = vatPosition(inv);
  if (!v.isDeclaredSupply) return { r, inv, v, state: 'N/A', why: `${inv.series}${inv.vat_registered_at_issue ? '' : ' / not VAT-registered'} — nothing was declared` };
  if (!v.hasOutputVat) return { r, inv, v, state: 'LISTED', why: 'zero-rated: no tax to reverse, but the supply IS in net outputs' };
  if (inv.credit_notes.length) return { r, inv, v, state: 'DONE', why: `covered by ${inv.credit_notes.map((c) => c.credit_note_number).join(', ')}` };
  return { r, inv, v, state: 'NEEDED', why: `${P(v.outputVatPennies)} of output VAT still declared` };
});

const by = (s) => rows.filter((x) => x.state === s);
console.log(`\nRefunds: ${rows.length}`);
console.log(`  NEEDED (issue a credit note) : ${by('NEEDED').length}`);
console.log(`  LISTED (zero-rated, none due): ${by('LISTED').length}`);
console.log(`  DONE   (already credited)    : ${by('DONE').length}`);
console.log(`  N/A    (never declared)      : ${by('N/A').length}`);
if (by('ORPHAN').length) console.log(`  ORPHAN                       : ${by('ORPHAN').length}  <-- investigate`);

for (const state of ['NEEDED', 'LISTED', 'ORPHAN', 'DONE', 'N/A']) {
  const set = by(state);
  if (!set.length) continue;
  console.log(`\n${state}`);
  for (const x of set) {
    const inv = x.inv;
    console.log(`  ${P(x.r.amount_pennies).padStart(10)}  ${x.r.collected_at.toISOString().slice(0, 10)}  `
      + `${inv?.group.ref ?? '—'} ${inv?.invoice_number ?? '—'}  ${x.why}`);
  }
}

// A NON-ZERO EXIT WHEN WORK IS OUTSTANDING, so this can be wired to a check later without changing
// its shape. LISTED is not outstanding work — nothing is owed for it.
const outstanding = by('NEEDED').length + by('ORPHAN').length;
console.log(`\n${outstanding} refund(s) awaiting a credit note.`);
await prisma.$disconnect();
process.exit(outstanding ? 1 : 0);
