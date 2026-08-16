/**
 * File: scripts/credit-note-gate.mjs
 * Credit notes: the four predicates, the mint, and the VAT return actually netting down.
 *
 * ── WHAT THIS IS FOR ────────────────────────────────────────────────────────────────────────────
 * The accountant's ruling (2026-08-17): a refunded stamp proves the payment EVENT but does not
 * reverse output VAT, so every refund until now left the garage's VAT record overstated. A credit
 * note is the correction, on its own sequence, dated on its own clock.
 *
 * ── THE TWO CLOCKS, ASSERTED ────────────────────────────────────────────────────────────────────
 * The sharpest check here is that a credit note dated in a DIFFERENT period from the refund moves
 * the VAT return in the credit note's period and leaves the cash figure where the money actually
 * went. That is not a bug being tolerated; it is the ruling, and a future "tidy-up" that aligned
 * them would be undoing a decision rather than fixing an inconsistency.
 *
 * ── FIXTURES ────────────────────────────────────────────────────────────────────────────────────
 * ZZ only. The credit note and its lines are removed in the finally; nothing on the invoice is
 * touched, so there is no invoice state to restore.
 */
import './_gate-preflight.mjs';
import './_ts.mjs';
const { prisma } = await import('../lib/db.ts');
const { vatPosition, creditNoteRequired, refuseCreditAmount, correctionShape, creditNoteMovesJobCard, mintCreditNote } =
  await import('../lib/credit-note.ts');
const { getVatSummary } = await import('../lib/vat-summary.ts');

const ZZ = 'c75ac44e-250a-4c90-98ba-a8326e98dad5';
const REASON = 'credit-note-gate fixture';
const out = [];
const check = (n, ok, d = '') => { out.push(ok ? 'P' : 'F'); console.log(`${ok ? '✓' : '✗'} ${n}${d ? `  — ${d}` : ''}`); };
const P = (p) => `£${(p / 100).toFixed(2)}`;

let madeId = null;
try {
  // ── 1. IS THERE ANYTHING TO REVERSE? THE STATED PREDICATE ──────────────────────────────────
  console.log('\n— when a credit note is required —');
  const L = (net, vat, rate) => ({ line_total: net, line_vat: vat, vat_rate: rate });
  const chargeableVat = { series: 'chargeable', vat_registered_at_issue: true, lines: [L(100, 20, 20)] };
  const chargeableZero = { series: 'chargeable', vat_registered_at_issue: true, lines: [L(50, 0, 0)] };
  const notRegistered = { series: 'chargeable', vat_registered_at_issue: false, lines: [L(100, 0, 0)] };
  const warranty = { series: 'warranty', vat_registered_at_issue: true, lines: [L(0, 0, 20)] };
  const historical = { series: 'historical', vat_registered_at_issue: true, lines: [L(100, 20, 20)] };

  check('a standard-rated chargeable invoice REQUIRES one', creditNoteRequired(chargeableVat));
  check('warranty does NOT — £0 goodwill is not a sale', !creditNoteRequired(warranty));
  check('historical does NOT — the tax was declared under the previous system', !creditNoteRequired(historical),
    'stated here rather than left to the series filter in every VAT read');
  check('an unregistered tenant does NOT', !creditNoteRequired(notRegistered));

  // THE ZERO-RATED CASE — the one real refund in the database. Output tax nil, supply still declared.
  const z = vatPosition(chargeableZero);
  check('ZERO-RATED: no output VAT to reverse', z.hasOutputVat === false && z.outputVatPennies === 0);
  check('ZERO-RATED: but it IS still a declared supply', z.isDeclaredSupply === true,
    'net outputs include it — conflating the two is how "no VAT" becomes "not a sale"');
  check('the check is discriminating — the two flags genuinely differ here',
    z.isDeclaredSupply !== z.hasOutputVat, 'if they always agreed, one of them would be decoration');

  // ── 2. THE CAP — AGAINST WHAT WAS INVOICED, NOT WHAT WAS RECEIVED ──────────────────────────
  console.log('\n— the cap —');
  check('the full invoiced amount is allowed', refuseCreditAmount(10000, 0, 10000) === null);
  check('a penny more is refused', refuseCreditAmount(10000, 0, 10001)?.code === 'exceeds_invoiced');
  check('partials summing past the invoice are refused', refuseCreditAmount(10000, 6000, 4001)?.code === 'exceeds_invoiced');
  check('exactly the remainder is allowed', refuseCreditAmount(10000, 6000, 4000) === null);
  check('a fully-credited invoice is refused', refuseCreditAmount(10000, 10000, 1)?.code === 'fully_credited');
  check('zero and negative are refused', refuseCreditAmount(10000, 0, 0)?.code === 'bad_amount'
    && refuseCreditAmount(10000, 0, -1)?.code === 'bad_amount');
  // IT IS NOT THE REFUND CAP. A part-paid invoice can be credited in full while only part of it
  // could be refunded — different questions, deliberately different predicates.
  const { refundableForPayment, refuseManualAmount } = await import('../lib/refund-eligibility.ts');
  const partPaid = refundableForPayment({
    id: 'p', provider: 'manual', status: 'succeeded', amount_pennies: 4000, currency: 'GBP',
    collected_at: new Date(), payment_method_snapshot: 'Cash', refunds: [],
  });
  check('the two caps genuinely differ on a part-paid invoice',
    refuseCreditAmount(10000, 0, 10000) === null && refuseManualAmount(partPaid, 10000)?.code === 'exceeds_remaining',
    'credit £100 against a £100 invoice: allowed. Refund £100 against £40 received: refused.');

  // ── 3. CREDIT-ONLY vs CREDIT-AND-REPLACE ───────────────────────────────────────────────────
  console.log('\n— which shape —');
  check('a pure reduction on a SETTLED invoice is credit-only',
    correctionShape({ invoicedPennies: 10000, receivedPennies: 10000, correctedPennies: 7000 }) === 'credit_only',
    'a replacement for money already received needs a payment allocation to look paid — machinery for a rule that does not apply');
  check('an UNPAID invoice being reduced still gets a replacement',
    correctionShape({ invoicedPennies: 10000, receivedPennies: 0, correctedPennies: 7000 }) === 'credit_and_replace',
    'the customer still owes something and needs a document to pay');
  check('an INCREASE always gets a replacement',
    correctionShape({ invoicedPennies: 10000, receivedPennies: 10000, correctedPennies: 12000 }) === 'credit_and_replace');
  check('a part-paid reduction gets a replacement',
    correctionShape({ invoicedPennies: 10000, receivedPennies: 4000, correctedPennies: 7000 }) === 'credit_and_replace');

  // ── 4. THE JOB CARD DOES NOT MOVE ──────────────────────────────────────────────────────────
  check('issuing a credit note never moves the job card', creditNoteMovesJobCard() === false,
    'a fact about a document, not about the work — the same rule a refund follows');

  // ── 5. THE MINT, AND THE VAT RETURN NETTING DOWN ───────────────────────────────────────────
  console.log('\n— minted, and the return nets down —');
  const inv = await prisma.invoice.findFirst({
    where: { group_id: ZZ, series: 'chargeable', status: { in: ['issued', 'paid'] }, lines: { some: {} } },
    select: { id: true, invoice_number: true, site_id: true, date_issued: true, job_card_id: true,
      lines: { select: { position: true, description: true, item_type: true, qty: true, unit_price: true, vat_rate: true, line_total: true, line_vat: true } } },
    orderBy: { created_at: 'desc' },
  });
  if (!inv) throw new Error('no ZZ chargeable invoice with lines');
  const siteIds = (await prisma.site.findMany({ where: { group_id: ZZ }, select: { id: true } })).map((s) => s.id);

  // DELIBERATELY A DIFFERENT PERIOD from the invoice: the credit note's own date is the VAT clock.
  const cnDate = new Date(Date.UTC(2026, 4, 15)); // May 2026
  const mFrom = new Date(Date.UTC(2026, 4, 1)), mTo = new Date(Date.UTC(2026, 5, 1));
  const before = await getVatSummary(ZZ, siteIds, mFrom, mTo);
  const cardBefore = (await prisma.jobCard.findUnique({ where: { id: inv.job_card_id }, select: { status: true } })).status;

  const line = inv.lines[0];
  const minted = await prisma.$transaction(async (tx) => mintCreditNote(tx, {
    groupId: ZZ, invoiceId: inv.id, dateIssued: cnDate, reason: REASON, createdBy: null,
    lines: [{ position: 1, description: line.description, item_type: line.item_type,
      qty: Number(line.qty), unit_price: Number(line.unit_price), vat_rate: Number(line.vat_rate),
      line_total: Number(line.line_total), line_vat: Number(line.line_vat) }],
  }));
  const row = await prisma.creditNote.findUnique({ where: { id: minted.id }, select: { id: true, credit_note_number: true, sequence_value: true, date_issued: true, invoice_id: true } });
  madeId = row?.id ?? null;
  check('a credit note was minted', !!row, row?.credit_note_number);
  check('with its OWN number, from its OWN counter', /^CN/.test(row?.credit_note_number ?? ''),
    `${row?.credit_note_number} (seq ${row?.sequence_value}) — never a chargeable number`);
  check('it names the invoice it corrects', row?.invoice_id === inv.id);
  check('and carries the date it was GIVEN, not today', row?.date_issued.toISOString().slice(0, 10) === '2026-05-15');

  const after = await getVatSummary(ZZ, siteIds, mFrom, mTo);
  const netMoved = before.netPennies - after.netPennies;
  const vatMoved = before.vatPennies - after.vatPennies;
  check('the VAT return nets DOWN by the credited net', netMoved === Math.round(Number(line.line_total) * 100),
    `${P(before.netPennies)} → ${P(after.netPennies)}`);
  check('and by the credited VAT', vatMoved === Math.round(Number(line.line_vat) * 100),
    `${P(before.vatPennies)} → ${P(after.vatPennies)}`);
  check('the return REPORTS the credit rather than silently absorbing it', after.creditNoteCount === before.creditNoteCount + 1
    && after.creditedNetPennies > before.creditedNetPennies,
    `${after.creditNoteCount} credit note(s), ${P(after.creditedNetPennies)} credited — a period that nets down says why`);
  check('the job card did NOT move', (await prisma.jobCard.findUnique({ where: { id: inv.job_card_id }, select: { status: true } })).status === cardBefore,
    `${cardBefore} unchanged`);

  // Discriminating: the credit note's OWN period moved, and the INVOICE's period did not.
  const invFrom = new Date(Date.UTC(inv.date_issued.getUTCFullYear(), inv.date_issued.getUTCMonth(), 1));
  const invTo = new Date(Date.UTC(inv.date_issued.getUTCFullYear(), inv.date_issued.getUTCMonth() + 1, 1));
  if (invFrom.getTime() !== mFrom.getTime()) {
    const invPeriod = await getVatSummary(ZZ, siteIds, invFrom, invTo);
    check('the INVOICE’s own VAT period is untouched', invPeriod.creditNoteCount === 0,
      'the VAT clock follows the credit note’s date, not the invoice it corrects — two clocks, both correct');
  } else {
    check('the fixture uses a different period from the invoice', false, 'pick another month — the check above is vacuous otherwise');
  }
} catch (e) {
  check('run completed', false, String(e?.message ?? e).slice(0, 300));
} finally {
  if (madeId) {
    await prisma.creditNote.delete({ where: { id: madeId } }).catch(() => {});
    check('teardown removed the fixture credit note', (await prisma.creditNote.count({ where: { id: madeId } })) === 0);
  }
  await prisma.creditNote.deleteMany({ where: { reason: REASON } });
  check('no fixture credit note survives', (await prisma.creditNote.count({ where: { reason: REASON } })) === 0);
  console.log(`\n${out.filter((c) => c === 'F').length} failures of ${out.length}`);
  await prisma.$disconnect();
  process.exit(out.includes('F') ? 1 : 0);
}
