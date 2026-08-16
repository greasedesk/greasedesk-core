/**
 * File: scripts/refund-tab-gate.mjs
 * The Refund tab, both origins, through a real click — and the manual half is the one that is new.
 *
 * ── WHAT IT PROVES ──────────────────────────────────────────────────────────────────────────────
 *   1. the tab is always reachable and never completable (not part of the gated spine);
 *   2. a manual refund records with ITS OWN collected_at and method — not "now", not "unknown";
 *   3. it CANNOT exceed what was received, across one refund and across several partials;
 *   4. revenue falls in the REFUND'S period and the original month does not move;
 *   5. the job card does not move — a refund is a fact about money, not a step in the work;
 *   6. the customer's link and the garage's screen show the refunded state in the SAME WORDS.
 *
 * ── WHY THE MANUAL PATH WRITES AND THE CARD PATH DOES NOT ───────────────────────────────────────
 * Asserted here because it is the thing most likely to be "tidied" later into one endpoint. A card
 * refund asks Stripe and lets the webhook write, because Stripe refunds arrive from three
 * directions and a fourth writer would disagree with the other three. A till has one direction and
 * no webhook; the person at the counter is the only witness. Refund.payment_id being REQUIRED is
 * what keeps that from being a back door — you cannot refund money the ledger never saw.
 *
 * ── FIXTURES ────────────────────────────────────────────────────────────────────────────────────
 * ZZ only, on a manual payment. Every row written is removed and the invoice cache is CAPTURED AND
 * RESTORED, never recomputed. The pay link is minted BEFORE the refund, because offersPayLink
 * correctly refuses a refunded invoice — which is the real sequence a customer experiences.
 */
import './_gate-preflight.mjs';
import './_ts.mjs';
const { prisma } = await import('../lib/db.ts');
const { computeTabs, TAB_KEYS, NON_STAGE_TABS } = await import('../lib/jobcard-tabs.ts');
const { refundableForPayment, refuseManualAmount } = await import('../lib/refund-eligibility.ts');
const { receivedInPeriod, reconcileInvoice } = await import('../lib/payments.ts');
const { refundLines } = await import('../lib/invoice-refund-state.ts');
const { buildInvoiceDoc } = await import('../lib/invoice-doc.ts');
const { mintInvoicePayLink } = await import('../lib/invoice-pay-link.ts');
const { chromium } = await import('/Users/hugh/Developer/greasedesk-core/node_modules/playwright-core/index.mjs');

const ZZ = 'c75ac44e-250a-4c90-98ba-a8326e98dad5';
const B = process.env.GATE_BASE ?? 'http://localhost:3000';
const REASON = 'refund-tab-gate fixture';
const out = [];
const check = (n, ok, d = '') => { out.push(ok ? 'P' : 'F'); console.log(`${ok ? '✓' : '✗'} ${n}${d ? `  — ${d}` : ''}`); };
const P = (p) => `£${(p / 100).toFixed(2)}`;

let invId = null, cacheBefore, cardBefore = null, linkId = null, browser = null, payId = null, invStatusBefore = null;
const madeRefunds = [];

try {
  // ── 1. THE TAB MODEL ───────────────────────────────────────────────────────────────────────
  console.log('\n— the tab —');
  check('refund sits after invoice', TAB_KEYS.indexOf('refund') === TAB_KEYS.indexOf('invoice') + 1, TAB_KEYS.join(' → '));
  check('it is declared a NON-STAGE tab', NON_STAGE_TABS.includes('refund'));
  const states = [
    { status: 'draft', stages: {}, hasOwner: false, hasRegistration: false },
    { status: 'invoiced', stages: { details: true, intake: true, injob: true, complete: true }, hasOwner: true, hasRegistration: true },
    { status: 'cancelled', stages: {}, hasOwner: false, hasRegistration: false },
  ].map((s) => computeTabs(s));
  check('ALWAYS reachable, even on an empty draft', states.every((t) => t.refund.reachable),
    'a garage that cannot find the control concludes the product cannot do refunds');
  check('NEVER completable, in any state', states.every((t) => t.refund.complete === false));
  check('the check is discriminating — invoice IS gated', states[0].invoice.reachable === false);

  // ── 2. THE CAP, AS A PURE RULE ─────────────────────────────────────────────────────────────
  console.log('\n— you cannot hand back more than came in —');
  const mk = (amount, refunds, status = 'succeeded', provider = 'manual') => refundableForPayment({
    id: 'p', provider, status, amount_pennies: amount, currency: 'GBP',
    collected_at: new Date('2026-06-10T10:00:00Z'), payment_method_snapshot: 'Cash', refunds,
  });
  check('the full amount is allowed', refuseManualAmount(mk(10000, []), 10000) === null);
  check('a penny more is REFUSED', refuseManualAmount(mk(10000, []), 10001)?.code === 'exceeds_remaining');
  check('two partials summing past the total are refused', refuseManualAmount(mk(10000, [{ amount_pennies: 6000 }]), 4001)?.code === 'exceeds_remaining',
    'salami-slicing is the way a per-refund cap gets beaten');
  check('exactly the remainder is allowed', refuseManualAmount(mk(10000, [{ amount_pennies: 6000 }]), 4000) === null);
  check('zero and negative are refused', refuseManualAmount(mk(10000, []), 0)?.code === 'bad_amount'
    && refuseManualAmount(mk(10000, []), -500)?.code === 'bad_amount');
  check('an unsettled payment is refused', refuseManualAmount(mk(10000, [], 'processing'), 100)?.code === 'not_settled');
  check('a fully-refunded payment is refused', refuseManualAmount(mk(10000, [{ amount_pennies: 10000 }]), 100)?.code === 'fully_refunded');

  // ── 3. A MANUAL REFUND, THROUGH THE REAL FORM ──────────────────────────────────────────────
  // THE REAL SEQUENCE, built rather than found: issue → send a pay link → take the money at the
  // counter → refund part of it. A pay link cannot be minted against an already-paid invoice
  // (offersPayLink refuses one with nothing to pay, correctly), so a gate that looks for a paid
  // invoice and then tries to mint is testing an order that never happens.
  const inv = await prisma.invoice.findFirst({
    where: { group_id: ZZ, series: 'chargeable', status: 'issued', lines: { some: {} } },
    select: { id: true, job_card_id: true, site_id: true, invoice_number: true, amount_paid_pennies: true, status: true },
    orderBy: { created_at: 'desc' },
  });
  if (!inv) throw new Error('no issued ZZ invoice to build the fixture on');
  invId = inv.id;
  cacheBefore = inv.amount_paid_pennies;
  invStatusBefore = inv.status;
  cardBefore = (await prisma.jobCard.findUnique({ where: { id: inv.job_card_id }, select: { status: true } })).status;

  const doc0 = await buildInvoiceDoc(invId, ZZ);
  const link = await mintInvoicePayLink({ doc: doc0, groupId: ZZ, recipient: 'gate', createdByUserId: null });
  if (!link) throw new Error('pay link refused');
  linkId = link.id;

  // The money in. Written directly rather than through the counter UI — that path has its own gate
  // (counter-payment-gate) and re-driving it here would test it twice and this once.
  const gross = doc0.vatRegistered ? doc0.totals.grossPennies : doc0.totals.netPennies;
  const method = await prisma.paymentMethod.findFirst({ where: { group_id: ZZ, behaviour: 'instant' }, select: { id: true, name: true } });
  if (!method) throw new Error('no instant ZZ payment method');
  const payCollected = new Date(Date.now() - 100 * 86_400_000); // a CLOSED month, so check 4 means something
  payId = (await prisma.payment.create({
    data: { group_id: ZZ, invoice_id: invId, site_id: inv.site_id, provider: 'manual', status: 'succeeded',
      amount_pennies: gross, currency: 'GBP', source_ref: `${REASON}:pay`, collected_at: payCollected,
      payment_method_id: method.id, payment_method_snapshot: method.name },
    select: { id: true },
  })).id;
  await prisma.$transaction(async (tx) => { await reconcileInvoice(tx, invId); });
  await prisma.invoice.update({ where: { id: invId }, data: { status: 'paid', paid_at: payCollected, date_paid: payCollected } });
  const pay = { id: payId, amount_pennies: gross, collected_at: payCollected, invoice: inv };

  // A BACK-DATED refund, deliberately: the whole point of collected_at is that money handed back on
  // Friday and typed in on Tuesday moved on Friday. `now` would pass a weaker test.
  const backDated = new Date(Date.now() - 40 * 86_400_000);
  const iso = backDated.toISOString().slice(0, 10);
  const monthFrom = new Date(Date.UTC(backDated.getUTCFullYear(), backDated.getUTCMonth(), 1));
  const monthTo = new Date(Date.UTC(backDated.getUTCFullYear(), backDated.getUTCMonth() + 1, 1));
  const origFrom = new Date(Date.UTC(pay.collected_at.getUTCFullYear(), pay.collected_at.getUTCMonth(), 1));
  const origTo = new Date(Date.UTC(pay.collected_at.getUTCFullYear(), pay.collected_at.getUTCMonth() + 1, 1));
  const siteIds = (await prisma.site.findMany({ where: { group_id: ZZ }, select: { id: true } })).map((s) => s.id);
  const rev = (from, to) => receivedInPeriod(prisma, { groupId: ZZ, siteIds, from, to });
  const refundMonthBefore = await rev(monthFrom, monthTo);
  const origMonthBefore = await rev(origFrom, origTo);
  const amount = Math.round(pay.amount_pennies / 4); // a PARTIAL — the ordinary workshop case

  console.log(`\n— recording ${P(amount)} back on ${pay.invoice.invoice_number}, dated ${iso} —`);
  browser = await chromium.launch({ channel: 'chrome' });
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto(`${B}/admin/login`, { waitUntil: 'domcontentloaded' });
  await page.fill('input[type="email"]', 'owner@zzgategarage.test');
  await page.fill('input[type="password"]', 'GateGarage!2026');
  await Promise.all([page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 60000 }), page.click('button[type="submit"]')]);

  await page.goto(`${B}/admin/jobcards/${pay.invoice.job_card_id}`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: 'Refund', exact: false }).first().click();
  await page.waitForSelector('[data-testid="refund-open"]', { timeout: 25000 });
  check('the tab opens and offers the control', await page.locator('[data-testid="refund-open"]').count() > 0);
  await page.locator('[data-testid="refund-open"]').first().click();
  await page.waitForSelector('[data-testid="refund-amount"]', { timeout: 15000 });
  await page.fill('[data-testid="refund-amount"]', (amount / 100).toFixed(2));
  await page.fill('[data-testid="refund-date"]', iso);
  await page.fill('[data-testid="refund-reason"]', REASON);
  await page.locator('[data-testid="refund-review"]').click();
  await page.waitForSelector('[data-testid="refund-send"]', { timeout: 15000 });
  await page.locator('[data-testid="refund-send"]').click();
  for (let i = 0; i < 40; i++) {
    if (await prisma.refund.count({ where: { reason: REASON } })) break;
    await page.waitForTimeout(500);
  }

  const row = await prisma.refund.findFirst({
    where: { reason: REASON },
    select: { id: true, amount_pennies: true, collected_at: true, payment_method_snapshot: true, payment_id: true,
      source_ref: true, refund_id: true, application_fee_refunded_pennies: true, created_by: true },
  });
  if (row) madeRefunds.push(row.id);
  check('a Refund row was written', !!row, row ? `${P(row.amount_pennies)}` : 'NONE — the click did not reach the ledger');
  check('for exactly the amount entered', row?.amount_pennies === amount, row ? `${P(row.amount_pennies)} vs ${P(amount)}` : '—');

  // ── THE TWO FACTS THE MODEL MUST CARRY ─────────────────────────────────────────────────────
  check('it carries ITS OWN collected_at, back-dated', row?.collected_at.toISOString().slice(0, 10) === iso,
    row ? `${row.collected_at.toISOString().slice(0, 10)} (not today)` : '—');
  check('and the METHOD it went back by, snapshotted', !!row?.payment_method_snapshot, row?.payment_method_snapshot ?? '—');
  check('it points at a real Payment row', row?.payment_id === pay.id,
    'payment_id is required by the model — you cannot refund money the ledger never saw');
  check('no Stripe identity is invented', row?.refund_id === null && String(row?.source_ref).startsWith('manual:'),
    row?.source_ref ?? '—');
  check('the application fee is NULL, not 0', row?.application_fee_refunded_pennies === null,
    'there is no fee on a payment we never processed; 0 would claim we kept one');

  // TWO FACTS, TWO ROWS: the audit says WHO, the ledger says the money.
  const audit = await prisma.auditLog.findFirst({
    where: { group_id: ZZ, action: 'refund.requested', entity_id: pay.invoice.job_card_id },
    orderBy: { created_at: 'desc' }, select: { user_id: true, diff_json: true },
  });
  check('refund.requested records WHO asked', !!audit?.user_id, audit?.user_id ? 'user_id present' : 'no user on the audit row');
  check('and the ledger row carries the money', row?.amount_pennies === amount && !!audit,
    'different facts, different rows — neither substitutes for the other');

  // ── 4. THE PERIODS ─────────────────────────────────────────────────────────────────────────
  console.log('\n— which month moves —');
  const refundMonthAfter = await rev(monthFrom, monthTo);
  const origMonthAfter = await rev(origFrom, origTo);
  check('revenue falls in the REFUND’S month', refundMonthBefore.netPennies - refundMonthAfter.netPennies === amount,
    `${P(refundMonthBefore.netPennies)} → ${P(refundMonthAfter.netPennies)}`);
  check('the month the money CAME IN does not move', origMonthAfter.receivedPennies === origMonthBefore.receivedPennies,
    `${P(origMonthBefore.receivedPennies)} unchanged — a closed month is a record, not a running total`);

  // ── 5. THE JOB CARD DOES NOT MOVE ──────────────────────────────────────────────────────────
  const cardAfter = (await prisma.jobCard.findUnique({ where: { id: pay.invoice.job_card_id }, select: { status: true } })).status;
  check('the job card status is untouched', cardAfter === cardBefore, `${cardBefore} → ${cardAfter}`);

  // ── 6. THE SAME WORDS ON BOTH SCREENS ──────────────────────────────────────────────────────
  console.log('\n— the customer reads what the garage reads —');
  const cust = await ctx.newPage();
  await cust.goto(link.url.replace(/^https?:\/\/[^/]+/, B), { waitUntil: 'domcontentloaded' });
  await cust.waitForSelector('[data-testid="refund-headline"]', { timeout: 25000 });
  const textOf = async (pg, id) => (await pg.locator(`[data-testid="${id}"]`).count())
    ? (await pg.locator(`[data-testid="${id}"]`).first().innerText()).trim() : null;
  const cH = await textOf(cust, 'refund-headline'), cD = await textOf(cust, 'refund-detail');
  await page.goto(`${B}/admin/invoices/${invId}`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-testid="admin-refund-state"]', { timeout: 25000 });
  const gH = await textOf(page, 'refund-headline'), gD = await textOf(page, 'refund-detail');
  check('the HEADLINES are byte-identical', !!cH && cH === gH, cH === gH ? cH : `customer ${JSON.stringify(cH)} / garage ${JSON.stringify(gH)}`);
  // BYTE-EQUALITY IS SATISFIED BY BOTH BEING WRONG. On the first green run both screens agreed on
  // "16 August 2026" for a refund dated 7 July: refundState read created_at (when the row was
  // written) instead of collected_at (when the money moved) — invisible while the Stripe webhook
  // was the only writer, because it writes seconds after the event. So the date is asserted against
  // the DATE THE GARAGE ENTERED, not merely against the other screen.
  const shownDate = new Date(`${iso}T12:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
  check('and the date shown is the date the money MOVED', !!cH && cH.includes(shownDate),
    `expected “${shownDate}” in “${cH}”`);
  check('the DETAIL lines are byte-identical', cD === gD, cD === gD ? '' : `customer ${JSON.stringify(cD)} / garage ${JSON.stringify(gD)}`);
  // Discriminating: the shared formatter is what makes that true, not luck.
  const d = await buildInvoiceDoc(invId, ZZ);
  const shared = refundLines(d.refund, { money: (x) => new Intl.NumberFormat(d.locale, { style: 'currency', currency: d.currency }).format(x / 100), locale: d.locale });
  check('and both equal lib/invoice-refund-state::refundLines', cH === shared?.headline,
    'one formatter, so a timezone or a rounding cannot diverge the two screens');
} catch (e) {
  check('run completed', false, String(e?.message ?? e).slice(0, 300));
} finally {
  await browser?.close().catch(() => {});
  if (madeRefunds.length) {
    const del = await prisma.refund.deleteMany({ where: { id: { in: madeRefunds } } });
    check('teardown removed the fixture refund', del.count === madeRefunds.length, `${del.count} of ${madeRefunds.length}`);
  }
  await prisma.refund.deleteMany({ where: { reason: REASON } });
  if (linkId) await prisma.customerMagicLink.deleteMany({ where: { id: linkId } });
  if (payId) await prisma.payment.delete({ where: { id: payId } }).catch(() => {});
  if (invId) {
    // CAPTURED AND RESTORED, never recomputed.
    await prisma.invoice.update({ where: { id: invId }, data: {
      amount_paid_pennies: cacheBefore ?? null,
      ...(invStatusBefore ? { status: invStatusBefore, paid_at: null, date_paid: null } : {}),
    } });
    const now = (await prisma.invoice.findUnique({ where: { id: invId }, select: { amount_paid_pennies: true } })).amount_paid_pennies;
    check('teardown restored the invoice cache exactly', now === (cacheBefore ?? null), `${JSON.stringify(cacheBefore)} → ${JSON.stringify(now)}`);
  }
  check('no fixture refund survives', (await prisma.refund.count({ where: { reason: REASON } })) === 0);
  console.log(`\n${out.filter((c) => c === 'F').length} failures of ${out.length}`);
  await prisma.$disconnect();
  process.exit(out.includes('F') ? 1 : 0);
}
