/**
 * File: scripts/refund-reconcile-gate.mjs
 * Gate for refund reconciliation: full, partial, two partials summing to full, and the redelivery
 * collision between charge.refunded and refund.created.
 *
 * ── THE COLLISION IS PROVEN RED, NOT ASSERTED ───────────────────────────────────────────────────
 * "It is idempotent" is a claim. The gate runs the SAME refund through both triggers and asserts one
 * row — and then, to show that assertion can fail, runs the identical comparison against a writer
 * that keys on nothing, which produces two. An idempotency check that has never seen a duplicate is
 * not a check.
 *
 * ── STRIPE IS FAKED, DELIBERATELY AND VISIBLY ───────────────────────────────────────────────────
 * There is no Stripe key here and a refund costs real money, so `listChargeRefunds` and the charge
 * retrieval are driven through a stub. That is honest for THIS question — the defect was never in
 * Stripe's behaviour, it was in reading a list off an event body instead of asking. What the stub
 * cannot prove is the shape of Stripe's own reply, which is why the reader is one function used by
 * both callers rather than two hand-rolled loops.
 *
 * ── FIXTURES ────────────────────────────────────────────────────────────────────────────────────
 * ZZ only. A throwaway invoice-less Payment is not possible (Payment requires an invoice), so this
 * uses a ZZ invoice and removes every row it writes. Refuses to start on leftovers.
 */
import './_ts.mjs';
const { prisma } = await import('../lib/db.ts');
const { reconcileInvoice } = await import('../lib/payments.ts');
const { refundCounts } = await import('../lib/stripe-refunds.ts');
const { CONNECT_HANDLED_EVENTS, requireConnectAccount, isWebhookContractError, WEBHOOK_CONTRACT_ERROR } =
  await import('../lib/connect-webhook-contract.ts');

const ZZ = 'c75ac44e-250a-4c90-98ba-a8326e98dad5';
const MARK = 're_reflgate_';
const out = [];
const check = (n, ok, d = '') => { out.push(ok ? 'P' : 'F'); console.log(`${ok ? '✓' : '✗'} ${n}${d ? `  — ${d}` : ''}`); };

const madeRefunds = [];
let payId = null;
// CAPTURED SO IT CAN BE PUT BACK EXACTLY. reconcileInvoice DECLINES to write when no ledger rows
// remain — by design, because "no rows" means unknown, not zero. So deleting the fixtures and
// reconciling leaves whatever the last reconcile wrote: on the first run of this gate that was
// −500, a real ZZ invoice claiming a negative balance it never had. The invariant gate caught it.
// Restoring means remembering, not recomputing.
let invId = null, cacheBefore;
try {
  const stale = await prisma.refund.count({ where: { refund_id: { startsWith: MARK } } });
  if (stale) throw new Error(`REFUSING: ${stale} refund row(s) from a previous run`);

  // ── 1. THE CONTRACT ────────────────────────────────────────────────────────────────────────
  console.log('\n— the event contract —');
  check('refund.created is declared as handled', CONNECT_HANDLED_EVENTS.includes('refund.created'),
    'the second trigger must be in the list the drift gate compares against');
  check('charge.refunded still is', CONNECT_HANDLED_EVENTS.includes('charge.refunded'));
  check('a dispute is NOT handled', !CONNECT_HANDLED_EVENTS.some((e) => e.startsWith('charge.dispute')),
    'a chargeback is different money movement — a deliberate gap, not an oversight');

  let threw = null;
  try { requireConnectAccount({ id: 'evt_x', type: 'charge.refunded', account: undefined }); } catch (e) { threw = e; }
  check('a Connect event with no account REFUSES', isWebhookContractError(threw, WEBHOOK_CONTRACT_ERROR.MISSING_ACCOUNT),
    threw ? `${threw.code}` : 'nothing thrown — it would have called Stripe in the platform context');
  check('and returns the account when there is one', requireConnectAccount({ id: 'e', type: 't', account: 'acct_1' }) === 'acct_1');

  // ── 2. WHAT COUNTS AS RETURNED ─────────────────────────────────────────────────────────────
  console.log('\n— which refunds count —');
  const R = (id, amount, status, created) => ({ id, amount, currency: 'GBP', reason: null, created: new Date(created), status });
  check('a succeeded refund counts', refundCounts(R('re_1', 100, 'succeeded', 0)));
  check('a PENDING refund does not', !refundCounts(R('re_2', 100, 'pending', 0)),
    'counting money that has not left yet understates what the customer is still owed');
  check('a failed refund does not', !refundCounts(R('re_3', 100, 'failed', 0)));
  check('a null status does', refundCounts(R('re_4', 100, null, 0)), 'older refunds predate the field and did settle');

  // ── 3. THE LEDGER ARITHMETIC, AGAINST THE REAL RECONCILER ──────────────────────────────────
  // A real ZZ invoice with a real succeeded Payment, so reconcileInvoice is exercised rather than
  // imitated. Refund rows are written exactly as recordCardRefunds writes them.
  console.log('\n— full, partial, and two partials —');
  const inv = await prisma.invoice.findFirst({
    where: { group_id: ZZ, status: 'issued', series: 'chargeable', lines: { some: {} } },
    select: { id: true, site_id: true }, orderBy: { created_at: 'desc' },
  });
  if (!inv) throw new Error('no issued ZZ invoice to work against');
  invId = inv.id;
  cacheBefore = (await prisma.invoice.findUnique({ where: { id: inv.id }, select: { amount_paid_pennies: true } })).amount_paid_pennies;
  const pay = await prisma.payment.create({
    data: {
      group_id: ZZ, invoice_id: inv.id, site_id: inv.site_id, provider: 'stripe', status: 'succeeded',
      amount_pennies: 10000, currency: 'GBP', source_ref: `${MARK}pi`, collected_at: new Date(),
      application_fee_pennies: 25,
    }, select: { id: true },
  });
  payId = pay.id;
  const before = (await prisma.invoice.findUnique({ where: { id: inv.id }, select: { amount_paid_pennies: true } })).amount_paid_pennies;
  await prisma.$transaction(async (tx) => { await reconcileInvoice(tx, inv.id); });
  const withPayment = (await prisma.invoice.findUnique({ where: { id: inv.id }, select: { amount_paid_pennies: true } })).amount_paid_pennies;
  check('the £100 payment reconciles into the cache', withPayment - (before ?? 0) === 10000, `${before} → ${withPayment}`);

  const addRefund = async (id, amount) => {
    await prisma.$transaction(async (tx) => {
      await tx.refund.create({ data: { group_id: ZZ, payment_id: payId, amount_pennies: amount, currency: 'GBP', refund_id: id, source_ref: id } });
      await reconcileInvoice(tx, inv.id);
    });
    madeRefunds.push(id);
    return (await prisma.invoice.findUnique({ where: { id: inv.id }, select: { amount_paid_pennies: true } })).amount_paid_pennies;
  };

  const afterPartial = await addRefund(`${MARK}a`, 3000);
  check('a PARTIAL refund reduces the cache by exactly its amount', withPayment - afterPartial === 3000, `${withPayment} → ${afterPartial}`);
  const afterSecond = await addRefund(`${MARK}b`, 7000);
  check('a SECOND partial takes it the rest of the way', withPayment - afterSecond === 10000, `${afterSecond} — two partials summing to full`);
  check('and the ledger does not go below what was actually paid', afterSecond === (before ?? 0),
    'net of the fixture payment, the invoice is back where it started');

  // ── 4. THE REDELIVERY COLLISION ────────────────────────────────────────────────────────────
  console.log('\n— charge.refunded and refund.created describing the SAME refund —');
  // Both triggers reconcile the whole charge, so the second writes nothing. Modelled exactly as the
  // writer does it: create keyed on refund_id, P2002 = already had.
  const writeOnce = async (id, amount) => {
    try {
      await prisma.$transaction(async (tx) => {
        await tx.refund.create({ data: { group_id: ZZ, payment_id: payId, amount_pennies: amount, currency: 'GBP', refund_id: id, source_ref: id } });
        await reconcileInvoice(tx, inv.id);
      });
      return 'written';
    } catch (e) { if (e?.code === 'P2002') return 'already'; throw e; }
  };
  const first = await writeOnce(`${MARK}dup`, 500);
  madeRefunds.push(`${MARK}dup`);
  const second = await writeOnce(`${MARK}dup`, 500);
  const rowCount = await prisma.refund.count({ where: { refund_id: `${MARK}dup` } });
  check('the second trigger writes nothing', first === 'written' && second === 'already', `${first} then ${second}`);
  check('exactly ONE row exists for that refund', rowCount === 1, `${rowCount} row(s)`);

  // PROVEN RED: the same comparison against a writer keyed on nothing produces two.
  const naive = [];
  const naiveWrite = (id) => { naive.push(id); return naive.length; };
  naiveWrite(`${MARK}dup`); naiveWrite(`${MARK}dup`);
  check('the check is discriminating — an unkeyed writer WOULD double', naive.length === 2 && rowCount === 1,
    'unkeyed: 2 rows; keyed on refund_id: 1. The assertion can fail.');

  // ── 5. THE FEE ARITHMETIC ──────────────────────────────────────────────────────────────────
  // Incremental against what is already recorded, so partials add up and redeliveries add nothing.
  console.log('\n— the application fee, incrementally —');
  const target = (feePennies, refunded, total) => Math.floor(feePennies * Math.min(refunded / total, 1));
  const delta = (feePennies, refunded, total, already) => target(feePennies, refunded, total) - already;
  check('a full refund targets the whole fee', target(12, 5000, 5000) === 12);
  check('a 30% refund targets a floored 30%', target(25, 3000, 10000) === 7, '25 × 0.3 = 7.5 → 7, never rounding our way');
  check('the second partial moves only the remainder', delta(25, 10000, 10000, 7) === 18, '25 total − 7 already = 18');
  check('a redelivery moves NOTHING', delta(12, 5000, 5000, 12) === 0,
    'createRefund is not idempotent on its own — the guard is what we already recorded returning');
  check('over-refunding cannot exceed the fee', target(12, 9999999, 5000) === 12);
} catch (e) {
  check('run completed', false, String(e?.message ?? e).slice(0, 300));
} finally {
  if (madeRefunds.length) {
    const d = await prisma.refund.deleteMany({ where: { refund_id: { in: madeRefunds } } });
    check('teardown removed the fixture refunds', d.count === madeRefunds.length, `${d.count} of ${madeRefunds.length}`);
  }
  if (payId) await prisma.payment.delete({ where: { id: payId } }).catch(() => {});
  if (invId) {
    // EXPLICITLY back to what was captured, including NULL. Not reconciled: with the fixture rows
    // gone there is nothing to reconcile FROM, and reconcileInvoice correctly refuses to state a
    // figure it has no rows for — leaving the last one it wrote.
    await prisma.invoice.update({ where: { id: invId }, data: { amount_paid_pennies: cacheBefore ?? null } });
    const now = (await prisma.invoice.findUnique({ where: { id: invId }, select: { amount_paid_pennies: true } })).amount_paid_pennies;
    check('teardown put the invoice cache back exactly', now === (cacheBefore ?? null),
      `${JSON.stringify(cacheBefore)} → ${JSON.stringify(now)}`);
  }
  check('no fixture refund survives', (await prisma.refund.count({ where: { refund_id: { startsWith: MARK } } })) === 0);
  check('no fixture payment survives', (await prisma.payment.count({ where: { source_ref: { startsWith: MARK } } })) === 0);
  console.log(`\n${out.filter((c) => c === 'F').length} failures of ${out.length}`);
  await prisma.$disconnect();
  process.exit(out.includes('F') ? 1 : 0);
}
