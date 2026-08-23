/**
 * File: scripts/refunded-state-gate.mjs
 * Gate for the refunded state: derived not stored, terminal not a return to `issued`, partials
 * named, and the job card left exactly where it was.
 *
 * The defect: invoice 100003210 told a customer "Paid in full — thank you" for three hours after
 * the £50 had gone back. Nothing on the page was wrong except the only thing the reader cared about.
 */
import './_gate-preflight.mjs';
const { serverReady } = await import('./_gate-preflight.mjs');
import './_ts.mjs';
const { prisma } = await import('../lib/db.ts');
const { refundState, hasRefund } = await import('../lib/invoice-refund-state.ts');
const { offersPayLink } = await import('../lib/invoice-pay-link.ts');
const { refusePayment } = await import('../lib/invoice-payment-intent.ts');
const { buildInvoiceDoc } = await import('../lib/invoice-doc.ts');
const { reconcileInvoice } = await import('../lib/payments.ts');

const ZZ = 'c75ac44e-250a-4c90-98ba-a8326e98dad5';
const MARK = 're_rfstate_';
const out = [];
const check = (n, ok, d = '') => { out.push(ok ? 'P' : 'F'); console.log(`${ok ? '✓' : '✗'} ${n}${d ? `  — ${d}` : ''}`); };
const D = (s) => new Date(s);

let payId = null, invId = null, cacheBefore, cardBefore = null, cardId = null;
let openId = null, openCacheBefore, pay2Id = null, linkId = null;
// PORT 3000, the port `npm run dev` uses. This defaulted to 3111 — not a decision, just whatever
// the author had running that afternoon. GATE_BASE still overrides.
const B = process.env.GATE_BASE ?? 'http://localhost:3000';
const madeRefunds = [];
try {
  if (await prisma.refund.count({ where: { refund_id: { startsWith: MARK } } })) throw new Error('REFUSING: leftovers');

  // ── 1. THE PURE RULE ───────────────────────────────────────────────────────────────────────
  console.log('\n— the rule —');
  // collected_at, not created_at: refundState reads WHEN THE MONEY MOVED. Both agreed while the
// Stripe webhook was the only writer; the manual refund path made them differ.
const R = (amount, at) => ({ amount_pennies: amount, collected_at: D(at) });
  check('no refunds is none', refundState({ receivedPennies: 5000, refunds: [] }).kind === 'none');
  check('the whole amount back is FULL', refundState({ receivedPennies: 5000, refunds: [R(5000, '2026-08-16')] }).kind === 'full');
  check('part of it is PARTIAL', refundState({ receivedPennies: 5000, refunds: [R(2000, '2026-08-16')] }).kind === 'partial');
  check('two partials summing to the whole is FULL',
    refundState({ receivedPennies: 5000, refunds: [R(2000, '2026-08-16'), R(3000, '2026-08-16')] }).kind === 'full',
    'the customer has all their money back; how many instalments it took is not their problem');
  check('an OVER-refund is still full, not partial',
    refundState({ receivedPennies: 5000, refunds: [R(6000, '2026-08-16')] }).kind === 'full',
    'goodwill processed as a refund must not read as money still outstanding');
  check('the date shown is the LATEST refund',
    refundState({ receivedPennies: 5000, refunds: [R(2000, '2026-08-16'), R(3000, '2026-08-16')] }).at.toISOString().startsWith('2026-08-16'),
    '"when did I get my money back" means the last of it');
  check('amounts are summed, not counted',
    refundState({ receivedPennies: 5000, refunds: [R(2000, '2026-08-16'), R(3000, '2026-08-16')] }).refundedPennies === 5000);
  check('hasRefund is silent on none', !hasRefund(refundState({ receivedPennies: 5000, refunds: [] }))
    && hasRefund(refundState({ receivedPennies: 5000, refunds: [R(1, '2026-08-16')] })));

  // THE COMPARISON MUST BE AGAINST GROSS RECEIVED, NOT THE NET CACHE. Using the cached balance —
  // which is already net of refunds — would make every full refund look partial.
  check('the check is discriminating: against the NET cache, a full refund would read partial', (() => {
    const grossBased = refundState({ receivedPennies: 5000, refunds: [R(5000, '2026-08-16')] }).kind;
    const netBased = refundState({ receivedPennies: 0, refunds: [R(5000, '2026-08-16')] }).kind; // cache after refund = 0
    return grossBased === 'full' && netBased === 'partial';
  })(), 'gross → full, net → partial. The doc must pass Σ succeeded payments, before refunds.');

  // ── 2. ON A REAL DOCUMENT ──────────────────────────────────────────────────────────────────
  console.log('\n— on a real ZZ invoice —');
  const inv = await prisma.invoice.findFirst({
    where: { group_id: ZZ, status: 'paid', lines: { some: {} } },
    select: { id: true, site_id: true, job_card_id: true }, orderBy: { created_at: 'desc' },
  });
  if (!inv) throw new Error('no paid ZZ invoice to work against');
  invId = inv.id; cardId = inv.job_card_id;
  cacheBefore = (await prisma.invoice.findUnique({ where: { id: invId }, select: { amount_paid_pennies: true } })).amount_paid_pennies;
  cardBefore = (await prisma.jobCard.findUnique({ where: { id: cardId }, select: { status: true } })).status;

  const pay = await prisma.payment.create({
    data: { group_id: ZZ, invoice_id: invId, site_id: inv.site_id, provider: 'stripe', status: 'succeeded',
      amount_pennies: 4000, currency: 'GBP', source_ref: `${MARK}pi`, collected_at: new Date() },
    select: { id: true },
  });
  payId = pay.id;
  await prisma.$transaction(async (tx) => { await reconcileInvoice(tx, invId); });

  const addRefund = async (id, amount) => {
    await prisma.$transaction(async (tx) => {
      await tx.refund.create({ data: { group_id: ZZ, payment_id: payId, amount_pennies: amount, currency: 'GBP', refund_id: id, source_ref: id, collected_at: new Date() } });
      await reconcileInvoice(tx, invId);
    });
    madeRefunds.push(id);
    return buildInvoiceDoc(invId, ZZ);
  };

  const docPartial = await addRefund(`${MARK}a`, 1500);
  check('the doc reports PARTIAL', docPartial.refund.kind === 'partial', `${docPartial.refund.refundedPennies}p back`);
  check('and carries the amount and the date', docPartial.refund.refundedPennies === 1500 && docPartial.refund.at instanceof Date);

  // THE TARGET IS READ FROM THE DOCUMENT, NOT ASSUMED. This invoice already carried a real payment
  // before the fixture added one, so "all of it" is the GROSS EVER RECEIVED, not the £40 this gate
  // put in. Hardcoding 4000 asserted the fixture rather than the behaviour and failed — correctly.
  const gross = docPartial.refund.receivedPennies;
  const docFull = await addRefund(`${MARK}b`, gross - 1500);
  check('the doc reports FULL once it all goes back', docFull.refund.kind === 'full',
    `${docFull.refund.refundedPennies}p of ${gross}p gross received`);

  // ── 3. TERMINAL, NOT A RETURN TO `issued` ──────────────────────────────────────────────────
  console.log('\n— what a refund does NOT do —');
  check('the document status stays paid', docFull.status === 'paid',
    'the invoice WAS paid; money came back afterwards. Two facts, not a correction of the first');
  check('no pay link is offered', offersPayLink(docFull) === false);
  check('and a mint attempt is refused', refusePayment(docFull, 4000)?.code === 'nothing_owing',
    'balance arithmetic says money is owed; the document says settled, and the document is right');
  const cardNow = (await prisma.jobCard.findUnique({ where: { id: cardId }, select: { status: true } })).status;
  check('THE JOB CARD DOES NOT MOVE', cardNow === cardBefore,
    `${cardBefore} → ${cardNow} — the work still happened; a refund is about money, not about whether the car was fixed`);

  // ── 4. IT IS DERIVED, SO IT CANNOT DRIFT ───────────────────────────────────────────────────
  console.log('\n— derived, not stored —');
  const cols = await prisma.$queryRawUnsafe(
    `SELECT column_name FROM information_schema.columns WHERE table_name='Invoice' AND column_name ILIKE '%refund%'`);
  check('there is no refunded column on Invoice', cols.length === 0,
    'a stored status is a second opinion, and it drifts the first time a refund lands without its writer running');
  const enumVals = await prisma.$queryRawUnsafe(
    `SELECT unnest(enum_range(NULL::"InvoiceStatus"))::text AS v`);
  check('and no `refunded` value on InvoiceStatus', !enumVals.some((r) => r.v === 'refunded'),
    enumVals.map((r) => r.v).join(', '));
  // ── 5. THE SERVED PAGE ─────────────────────────────────────────────────────────────────────
  // A pay link CANNOT be minted for a refunded invoice — offersPayLink refuses it, which is right
  // and is also why this has to be done in order: mint while the invoice is still open, THEN pay
  // and refund, then load the link the customer already holds. That is exactly the real sequence.
  console.log('\n— what the customer sees —');
  const { mintInvoicePayLink } = await import('../lib/invoice-pay-link.ts');
  const openInv = await prisma.invoice.findFirst({
    where: { group_id: ZZ, status: 'issued', series: 'chargeable', lines: { some: {} } },
    select: { id: true, site_id: true }, orderBy: { created_at: 'desc' },
  });
  if (!openInv) throw new Error('no open ZZ invoice to mint a link against');
  openId = openInv.id;
  openCacheBefore = (await prisma.invoice.findUnique({ where: { id: openId }, select: { amount_paid_pennies: true } })).amount_paid_pennies;
  const doc0 = await buildInvoiceDoc(openId, ZZ);
  const link = await mintInvoicePayLink({ doc: doc0, groupId: ZZ, recipient: 'gate', createdByUserId: null });
  if (!link) throw new Error('link refused');
  linkId = link.id;
  const url = link.url.replace(/^https?:\/\/[^/]+/, B);

  const gross2 = doc0.vatRegistered ? doc0.totals.grossPennies : doc0.totals.netPennies;
  const p2 = await prisma.payment.create({
    data: { group_id: ZZ, invoice_id: openId, site_id: openInv.site_id, provider: 'stripe', status: 'succeeded',
      amount_pennies: gross2, currency: 'GBP', source_ref: `${MARK}pi2`, collected_at: new Date() },
    select: { id: true } });
  pay2Id = p2.id;
  await prisma.$transaction(async (tx) => { await reconcileInvoice(tx, openId); });

  // The dev server disposes inactive pages and serves 404s while it rebuilds one; a gate that
  // drives a page that was never served dies as a bare selector timeout 25s later. Warm it and
  // say so — see serverReady in _gate-preflight.
  const ready = await serverReady();
  check('the dev server serves pages before we drive it', ready.ok, `HTTP ${ready.status} after ${ready.attempts} attempt(s)`);
  const browser = await (await import('/Users/hugh/Developer/greasedesk-core/node_modules/playwright-core/index.mjs')).chromium.launch({ channel: 'chrome' });
  try {
    const page = await (await browser.newContext({ viewport: { width: 390, height: 844 } })).newPage();
    const seen = async (id) => page.locator(`[data-testid="${id}"]`).count();
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('[data-testid="invoice-paid"], [data-testid="invoice-due"]', { timeout: 25000 });
    check('before any refund the page says paid', await seen('invoice-paid') === 1);

    await prisma.$transaction(async (tx) => {
      await tx.refund.create({ data: { group_id: ZZ, payment_id: pay2Id, amount_pennies: Math.floor(gross2 / 4), currency: 'GBP', refund_id: `${MARK}p1`, source_ref: `${MARK}p1`, collected_at: new Date() } });
      await reconcileInvoice(tx, openId);
    });
    madeRefunds.push(`${MARK}p1`);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('[data-testid="invoice-part-refunded"]', { timeout: 20000 });
    check('a PARTIAL refund is named on the served page', await seen('invoice-part-refunded') === 1,
      (await page.locator('[data-testid="invoice-part-refunded"]').innerText()).trim().split('\n')[0]);

    await prisma.$transaction(async (tx) => {
      await tx.refund.create({ data: { group_id: ZZ, payment_id: pay2Id, amount_pennies: gross2 - Math.floor(gross2 / 4), currency: 'GBP', refund_id: `${MARK}p2`, source_ref: `${MARK}p2`, collected_at: new Date() } });
      await reconcileInvoice(tx, openId);
    });
    madeRefunds.push(`${MARK}p2`);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('[data-testid="invoice-refunded"]', { timeout: 20000 });
    check('and a FULL refund replaces the thank-you', await seen('invoice-refunded') === 1
      && await seen('invoice-paid') === 0,
      (await page.locator('[data-testid="invoice-refunded"]').innerText()).trim().split('\n')[0]);
    check('with no Pay button anywhere', await seen('pay-start') === 0 && await seen('pay-panel') === 0,
      'a refunded invoice must not ask a customer who has been made whole to pay again');
  } finally { await browser.close().catch(() => {}); }
} catch (e) {
  check('run completed', false, String(e?.message ?? e).slice(0, 300));
} finally {
  if (madeRefunds.length) {
    const d = await prisma.refund.deleteMany({ where: { refund_id: { in: madeRefunds } } });
    check('teardown removed the fixture refunds', d.count === madeRefunds.length, `${d.count} of ${madeRefunds.length}`);
  }
  if (payId) await prisma.payment.delete({ where: { id: payId } }).catch(() => {});
  if (pay2Id) await prisma.payment.delete({ where: { id: pay2Id } }).catch(() => {});
  if (linkId) await prisma.customerMagicLink.deleteMany({ where: { id: linkId } });
  if (openId) {
    await prisma.invoice.update({ where: { id: openId }, data: { amount_paid_pennies: openCacheBefore ?? null } });
    const now = (await prisma.invoice.findUnique({ where: { id: openId }, select: { amount_paid_pennies: true } })).amount_paid_pennies;
    check('teardown restored the second invoice cache', now === (openCacheBefore ?? null), `${JSON.stringify(openCacheBefore)} → ${JSON.stringify(now)}`);
  }
  if (invId) {
    // CAPTURED AND RESTORED, never recomputed — reconcileInvoice declines to speak with no rows.
    await prisma.invoice.update({ where: { id: invId }, data: { amount_paid_pennies: cacheBefore ?? null } });
    const now = (await prisma.invoice.findUnique({ where: { id: invId }, select: { amount_paid_pennies: true } })).amount_paid_pennies;
    check('teardown put the invoice cache back exactly', now === (cacheBefore ?? null), `${JSON.stringify(cacheBefore)} → ${JSON.stringify(now)}`);
  }
  if (cardId) {
    const now = (await prisma.jobCard.findUnique({ where: { id: cardId }, select: { status: true } })).status;
    check('and the job card is untouched', now === cardBefore, `${cardBefore} → ${now}`);
  }
  check('no fixture row survives', (await prisma.refund.count({ where: { refund_id: { startsWith: MARK } } })) === 0
    && (await prisma.payment.count({ where: { source_ref: { startsWith: MARK } } })) === 0);
  console.log(`\n${out.filter((c) => c === 'F').length} failures of ${out.length}`);
  await prisma.$disconnect();
  process.exit(out.includes('F') ? 1 : 0);
}
