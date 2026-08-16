/**
 * File: scripts/revenue-period-gate.mjs
 * A CLOSED MONTH DOES NOT MOVE. Revenue is a record: money in in June, out in August, each month
 * says so.
 *
 * ── A PROPERTY, NOT A SNAPSHOT ──────────────────────────────────────────────────────────────────
 * Deliberately not a second golden over June's figures. June's derived numbers have four legitimate
 * movers — employment corrections, retrospective leave, the labour rate, editable overheads — so a
 * hash would cry wolf and be updated rather than investigated. This states the RULE instead: write
 * a refund dated today against a JUNE invoice, and assert June is unchanged while the current month
 * falls by exactly that amount. It cannot drift, and it goes red on exactly the defect.
 *
 * ── AND IT PROVES THE DEFECT EXISTED ────────────────────────────────────────────────────────────
 * The old basis is computed alongside the new one from the same rows, so the gate shows June moving
 * under the old rule and holding under the new. An assertion that has never seen the failure is not
 * an assertion.
 *
 * ── THE NULL-SITE CASE IS ASSERTED, BECAUSE IT NEARLY SHIPPED ───────────────────────────────────
 * Payment.site_id is nullable and one real row (£2,485.43) carries null while its invoice has a
 * site. Scoping on the payment's column silently dropped 27% of one August. The gate asserts such a
 * payment STILL counts toward its invoice's site.
 *
 * ── FIXTURES ────────────────────────────────────────────────────────────────────────────────────
 * ZZ only. Every row is removed and the invoice cache is captured and restored, never recomputed.
 */
import './_ts.mjs';
const { prisma } = await import('../lib/db.ts');
const { receivedInPeriod, reconcileInvoice } = await import('../lib/payments.ts');
const { invoiceTotals, effectivePaidDate } = await import('../lib/invoice.ts');

const ZZ = 'c75ac44e-250a-4c90-98ba-a8326e98dad5';
const MARK = 'revgate_';
const out = [];
const check = (n, ok, d = '') => { out.push(ok ? 'P' : 'F'); console.log(`${ok ? '✓' : '✗'} ${n}${d ? `  — ${d}` : ''}`); };
const P = (n) => `£${(n / 100).toFixed(2)}`;

// THE CLOSED MONTH IS DERIVED FROM THE INVOICE UNDER TEST, not hardcoded. The OLD rule buckets by
// the INVOICE's paid date, so demonstrating that it moves requires the invoice to actually sit in
// the month being checked. Hardcoding June asserted the fixture, not the behaviour — and failed,
// correctly, because ZZ's invoice was paid in a different month. Same lesson as the £40 refund
// target and the "Send quote to customer" label.
let JUNE_FROM, JUNE_TO;
const NOW_FROM = new Date('2026-08-01'), NOW_TO = new Date('2026-09-01');

/** THE OLD RULE, kept here so the gate can show the defect rather than assert its absence. */
async function oldBasis(siteIds, from, to) {
  const rows = await prisma.invoice.findMany({
    where: { group_id: ZZ, site_id: { in: siteIds }, status: 'paid', series: 'chargeable' },
    select: { date_paid: true, paid_at: true, amount_paid_pennies: true, lines: { select: { vat_rate: true, line_total: true, line_vat: true } } },
  });
  return rows
    .filter((r) => { const d = effectivePaidDate(r); return d && d >= from && d < to; })
    .reduce((a, r) => a + (r.amount_paid_pennies ?? invoiceTotals(r.lines).grossPennies), 0);
}

let payId = null, invId = null, cacheBefore, nullSitePayId = null, nullSiteInvId = null, nullSiteCache;
const madeRefunds = [];
try {
  if (await prisma.refund.count({ where: { refund_id: { startsWith: MARK } } })) throw new Error('REFUSING: leftovers');
  const siteIds = (await prisma.site.findMany({ where: { group_id: ZZ }, select: { id: true } })).map((s) => s.id);

  // THE FIXTURE MUST BE PAID IN A CLOSED MONTH — before the one the refund lands in, or "closed"
  // and "current" are the same window and the test cannot tell them apart. Selected by the property
  // the test needs, not by recency.
  const inv = await prisma.invoice.findFirst({
    where: {
      group_id: ZZ, status: 'paid', series: 'chargeable', lines: { some: {} },
      OR: [{ date_paid: { lt: NOW_FROM } }, { AND: [{ date_paid: null }, { paid_at: { lt: NOW_FROM } }] }],
    },
    select: { id: true, site_id: true }, orderBy: { created_at: 'desc' },
  });
  if (!inv) throw new Error('no ZZ invoice paid before the current month — cannot demonstrate a closed month');
  invId = inv.id;
  const full = await prisma.invoice.findUnique({ where: { id: invId }, select: { amount_paid_pennies: true, date_paid: true, paid_at: true } });
  cacheBefore = full.amount_paid_pennies;
  const paidOn = effectivePaidDate(full);
  if (!paidOn) throw new Error('fixture invoice has no paid date');
  JUNE_FROM = new Date(Date.UTC(paidOn.getUTCFullYear(), paidOn.getUTCMonth(), 1));
  JUNE_TO = new Date(Date.UTC(paidOn.getUTCFullYear(), paidOn.getUTCMonth() + 1, 1));
  console.log(`  the closed month under test: ${JUNE_FROM.toISOString().slice(0, 7)} (the fixture invoice's own paid month)`);

  // £200 received in the CLOSED month.
  payId = (await prisma.payment.create({
    data: { group_id: ZZ, invoice_id: invId, site_id: inv.site_id, provider: 'stripe', status: 'succeeded',
      amount_pennies: 20000, currency: 'GBP', source_ref: `${MARK}pi`, collected_at: new Date(JUNE_FROM.getTime() + 14 * 86400000) },
    select: { id: true },
  })).id;
  await prisma.$transaction(async (tx) => { await reconcileInvoice(tx, invId); });

  const juneBefore = await receivedInPeriod(prisma, { groupId: ZZ, siteIds, from: JUNE_FROM, to: JUNE_TO });
  const nowBefore = await receivedInPeriod(prisma, { groupId: ZZ, siteIds, from: NOW_FROM, to: NOW_TO });
  const juneOldBefore = await oldBasis(siteIds, JUNE_FROM, JUNE_TO);
  console.log(`\n— before the refund —\n  June ${P(juneBefore.netPennies)}   current ${P(nowBefore.netPennies)}`);
  check('the payment lands in the closed month', juneBefore.receivedPennies >= 20000, P(juneBefore.receivedPennies));

  // ── THE REFUND: TODAY, AGAINST THE JUNE INVOICE ────────────────────────────────────────────
  await prisma.$transaction(async (tx) => {
    await tx.refund.create({
      data: { group_id: ZZ, payment_id: payId, amount_pennies: 5000, currency: 'GBP',
        refund_id: `${MARK}r1`, source_ref: `${MARK}r1`, collected_at: new Date('2026-08-16T12:00:00Z') },
    });
    await reconcileInvoice(tx, invId);
  });
  madeRefunds.push(`${MARK}r1`);

  const juneAfter = await receivedInPeriod(prisma, { groupId: ZZ, siteIds, from: JUNE_FROM, to: JUNE_TO });
  const nowAfter = await receivedInPeriod(prisma, { groupId: ZZ, siteIds, from: NOW_FROM, to: NOW_TO });
  const juneOldAfter = await oldBasis(siteIds, JUNE_FROM, JUNE_TO);

  console.log(`\n— after a £50 refund dated TODAY against a JUNE invoice —`);
  check('THE CLOSED MONTH DOES NOT MOVE', juneAfter.netPennies === juneBefore.netPennies,
    `${P(juneBefore.netPennies)} → ${P(juneAfter.netPennies)}`);
  check('the CURRENT month falls by exactly the refund', nowBefore.netPennies - nowAfter.netPennies === 5000,
    `${P(nowBefore.netPennies)} → ${P(nowAfter.netPennies)}`);
  check('and the current month NAMES it', nowAfter.refundedPennies - nowBefore.refundedPennies === 5000,
    `refunded ${P(nowAfter.refundedPennies)} — the figure the tile prints under the total`);
  check('the closed month names nothing, because nothing happened in it', juneAfter.refundedPennies === juneBefore.refundedPennies);

  // PROVEN RED: the old rule moves June by the same £50.
  check('the check is discriminating — the OLD basis DID move June',
    juneOldBefore - juneOldAfter === 5000,
    `old: ${P(juneOldBefore)} → ${P(juneOldAfter)}; new: unchanged. This is the defect.`);

  // ── NEGATIVE IS SHOWN, NOT CLAMPED ─────────────────────────────────────────────────────────
  console.log('\n— a month that gave back more than it took —');
  const empty = await receivedInPeriod(prisma, { groupId: ZZ, siteIds, from: new Date('2020-01-01'), to: new Date('2020-02-01') });
  check('a month with nothing in it is zero, not null', empty.netPennies === 0 && empty.receivedPennies === 0);
  await prisma.$transaction(async (tx) => {
    await tx.refund.create({
      data: { group_id: ZZ, payment_id: payId, amount_pennies: 1000, currency: 'GBP',
        refund_id: `${MARK}r2`, source_ref: `${MARK}r2`, collected_at: new Date('2020-01-15T10:00:00Z') },
    });
    await reconcileInvoice(tx, invId);
  });
  madeRefunds.push(`${MARK}r2`);
  const neg = await receivedInPeriod(prisma, { groupId: ZZ, siteIds, from: new Date('2020-01-01'), to: new Date('2020-02-01') });
  check('a refund with no receipts gives a NEGATIVE month', neg.netPennies === -1000,
    `${P(neg.netPennies)} — a clamped zero would be a lie about a month that genuinely gave money back`);

  // ── THE NULL-SITE PAYMENT STILL COUNTS ─────────────────────────────────────────────────────
  console.log('\n— a payment whose own site_id is null —');
  const inv2 = await prisma.invoice.findFirst({
    where: { group_id: ZZ, status: 'paid', series: 'chargeable', id: { not: invId } },
    select: { id: true, site_id: true }, orderBy: { created_at: 'desc' },
  });
  if (!inv2) throw new Error('need a second ZZ invoice');
  nullSiteInvId = inv2.id;
  nullSiteCache = (await prisma.invoice.findUnique({ where: { id: inv2.id }, select: { amount_paid_pennies: true } })).amount_paid_pennies;
  nullSitePayId = (await prisma.payment.create({
    data: { group_id: ZZ, invoice_id: inv2.id, site_id: null, provider: 'manual', status: 'succeeded',
      amount_pennies: 7777, currency: 'GBP', source_ref: `${MARK}nullsite`, collected_at: new Date(JUNE_FROM.getTime() + 19 * 86400000) },
    select: { id: true },
  })).id;
  const withNull = await receivedInPeriod(prisma, { groupId: ZZ, siteIds, from: JUNE_FROM, to: JUNE_TO });
  check('it is COUNTED, via its invoice’s site', withNull.receivedPennies - juneAfter.receivedPennies === 7777,
    'scoping on Payment.site_id dropped £2,485.43 from a real August — the invoice is the authority');
  check('and attributed to the right site', (withNull.perSite.find((s) => s.siteId === inv2.site_id)?.receivedPennies ?? 0) >= 7777);
  // Discriminating: the naive scope would have missed it.
  const naive = await prisma.payment.aggregate({
    where: { group_id: ZZ, site_id: { in: siteIds }, status: 'succeeded', collected_at: { gte: JUNE_FROM, lt: JUNE_TO } },
    _sum: { amount_pennies: true },
  });
  check('the check is discriminating — scoping on Payment.site_id MISSES it',
    (naive._sum.amount_pennies ?? 0) === withNull.receivedPennies - 7777,
    'the naive query is short by exactly the null-site payment');
} catch (e) {
  check('run completed', false, String(e?.message ?? e).slice(0, 300));
} finally {
  if (madeRefunds.length) {
    const d = await prisma.refund.deleteMany({ where: { refund_id: { in: madeRefunds } } });
    check('teardown removed the fixture refunds', d.count === madeRefunds.length, `${d.count} of ${madeRefunds.length}`);
  }
  for (const id of [payId, nullSitePayId]) if (id) await prisma.payment.delete({ where: { id } }).catch(() => {});
  for (const [id, val] of [[invId, cacheBefore], [nullSiteInvId, nullSiteCache]]) {
    if (!id) continue;
    await prisma.invoice.update({ where: { id }, data: { amount_paid_pennies: val ?? null } });
  }
  if (invId) {
    const now = (await prisma.invoice.findUnique({ where: { id: invId }, select: { amount_paid_pennies: true } })).amount_paid_pennies;
    check('teardown restored the invoice cache exactly', now === (cacheBefore ?? null), `${JSON.stringify(cacheBefore)} → ${JSON.stringify(now)}`);
  }
  check('no fixture row survives', (await prisma.refund.count({ where: { refund_id: { startsWith: MARK } } })) === 0
    && (await prisma.payment.count({ where: { source_ref: { startsWith: MARK } } })) === 0);
  console.log(`\n${out.filter((c) => c === 'F').length} failures of ${out.length}`);
  await prisma.$disconnect();
  process.exit(out.includes('F') ? 1 : 0);
}
