/**
 * File: scripts/pay-refusal-gate.mjs
 * Gate for the three fixes to the card-payment refusal path.
 *
 * The defect this exists for: TMBS invoice 100003205 showed a customer a Pay button AND
 * "Card payment isn't available for this invoice" at the same time, and the log could not say why.
 *
 *   1. OUR exceptions were classified as Stripe's. A Prisma error from the transaction AFTER the
 *      Stripe call was logged as "paymentIntents.create failed" and rendered in Stripe's wording.
 *   2. The fee resolution sat OUTSIDE the shared predicate, so the page could offer what the
 *      endpoint would refuse.
 *   3. A settled refusal left the button on screen beside its own denial.
 *
 * ── DRIVING A REAL SETTLED REFUSAL WITHOUT MOVING MONEY ─────────────────────────────────────────
 * The interesting UI branch needs canPay TRUE (or the panel never renders) and the endpoint
 * refusing. So the served build runs with a DELIBERATELY INVALID Stripe key: preconditions pass,
 * the Stripe call is genuinely attempted, and Stripe answers StripeAuthenticationError →
 * key_rejected, retryable:false. Nothing is charged, no PaymentIntent is created, and the refusal
 * is Stripe's own rather than a simulation of one.
 *
 * ── FIXTURES ────────────────────────────────────────────────────────────────────────────────────
 * ZZ only. One ProviderConnection row, created here and deleted in the finally; it refuses to start
 * if ZZ already has one, because clobbering a real connection is not a thing a gate may do. The
 * magic link it mints is a real credential for a ZZ invoice and is revoked on the way out.
 */
import './_gate-preflight.mjs';
import './_ts.mjs';
const { prisma } = await import('../lib/db.ts');
const { isStripeError, classifyStripeError } = await import('../lib/stripe-errors.ts');
const { payPreconditions, canOfferCardPayment, refusePayment } = await import('../lib/invoice-payment-intent.ts');
const { buildInvoiceDoc } = await import('../lib/invoice-doc.ts');
const { balanceOwedPennies } = await import('../lib/invoice.ts');
const { mintInvoicePayLink } = await import('../lib/invoice-pay-link.ts');
const { chromium } = await import('/Users/hugh/Developer/greasedesk-core/node_modules/playwright-core/index.mjs');

const ZZ = 'c75ac44e-250a-4c90-98ba-a8326e98dad5';
const INV = 'b5c2ccd2-7b07-40e7-9228-067b25171750';
// PORT 3000, the port `npm run dev` uses. This defaulted to 3112 — not a decision, just whatever
// the author had running that afternoon. Six gates carried defaults like it, so six gates skipped
// on every machine but one; both of the two tested pass unchanged against 3000. GATE_BASE still
// overrides, which is what a genuinely different server is for.
const B = process.env.GATE_BASE ?? 'http://localhost:3000';
const out = [];
const check = (n, ok, d = '') => { out.push(ok ? 'P' : 'F'); console.log(`${ok ? '✓' : '✗'} ${n}${d ? `  — ${d}` : ''}`); };

// The pay limiter is shared and time-windowed (10/hour on `pay:ip:`). This gate spends from it,
// and leaving the budget behind makes the NEXT pay gate 429 in a way that reads as an endpoint
// defect rather than as our own litter. Released in the finally, scoped to this run.
const startedAt = new Date();

let connId = null;
let linkId = null;
let browser = null;
try {
  // ── 1. WHOSE FAULT IS IT? ──────────────────────────────────────────────────────────────────
  console.log('\n— our exceptions vs Stripe’s —');
  check('a plain Error is not a Stripe error', isStripeError(new Error('boom')) === false);
  const prismaish = Object.assign(new Error('Unique constraint failed'), { code: 'P2002' });
  check('nor is a Prisma error', isStripeError(prismaish) === false,
    'this is the shape that was being logged as paymentIntents.create');
  check('a Stripe SDK error is', isStripeError({ type: 'StripeInvalidRequestError' }) === true);
  check('and the test is on the TYPE, not the presence of a code', isStripeError({ code: 'card_declined' }) === false,
    'a `code` alone belongs to plenty of things that are not Stripe');

  const asStripe = classifyStripeError(prismaish);
  check('classifying our own error yields UNKNOWN, non-retryable', asStripe.code === 'unknown' && asStripe.retryable === false,
    `${asStripe.code}/retryable=${asStripe.retryable} — the old path sent this to the customer as Stripe’s answer`);
  check('and it invents no Stripe message', asStripe.stripeMessage === null && asStripe.requestId === null,
    'honest-null: Stripe never answered, so there is nothing of Stripe’s to quote');

  // ── 2. THE FEE IS INSIDE THE SHARED PREDICATE ──────────────────────────────────────────────
  console.log('\n— what the predicate covers —');
  const stale = await prisma.providerConnection.count({ where: { group_id: ZZ } });
  if (stale) throw new Error(`REFUSING: ZZ already has ${stale} ProviderConnection row(s)`);
  const conn = await prisma.providerConnection.create({
    data: {
      group_id: ZZ, provider: 'stripe', external_id: 'acct_gatefixture', livemode: false,
      charges_enabled: true, payouts_enabled: true, requirements_due: [], connected_at: new Date(),
      capabilities: { card_payments: 'active', transfers: 'active' },
    },
    select: { id: true },
  });
  connId = conn.id;

  const doc = await buildInvoiceDoc(INV, ZZ);
  const inv = await prisma.invoice.findUnique({ where: { id: INV }, select: { amount_paid_pennies: true } });
  const total = doc.vatRegistered ? doc.totals.grossPennies : doc.totals.netPennies;
  const balance = balanceOwedPennies(inv, total);
  check('the fixture invoice has something to pay', refusePayment(doc, balance) === null && balance > 0, `£${(balance / 100).toFixed(2)}`);

  const gbp = await payPreconditions({ groupId: ZZ, doc, balancePennies: balance });
  check('GBP resolves a fee through the predicate', gbp.ok === true && typeof gbp.feePennies === 'number',
    gbp.ok ? `${gbp.feePennies}p, rate ${gbp.rateId?.slice(0, 8)}` : `refused ${gbp.refusal?.code}`);

  // THE CASE THAT USED TO ESCAPE. No rate exists for GB/EUR, so the fee resolution throws — which
  // the endpoint met as an exception and the page could not see at all.
  const eur = await payPreconditions({ groupId: ZZ, doc: { ...doc, currency: 'EUR' }, balancePennies: balance });
  check('a currency with NO rate is a REFUSAL, not an exception', eur.ok === false && eur.refusal.code === 'no_rate',
    eur.ok ? 'resolved — the no-rate branch did not fire' : eur.refusal.code);
  const eurOffer = await canOfferCardPayment({ groupId: ZZ, doc: { ...doc, currency: 'EUR' }, balancePennies: balance });
  check('and the PAGE sees it — no button would be offered', eurOffer === false,
    'this is the divergence: the fee used to be outside the predicate entirely');
  check('the check is discriminating', (await canOfferCardPayment({ groupId: ZZ, doc, balancePennies: balance })) === true
    && eurOffer === false, 'GBP true, EUR false — from the same predicate');

  // ── 3. THE SERVED PAGE ─────────────────────────────────────────────────────────────────────
  console.log('\n— a settled refusal on the customer’s page —');
  const link = await mintInvoicePayLink({ doc, groupId: ZZ, recipient: 'gate', createdByUserId: null });
  if (!link) throw new Error('mintInvoicePayLink refused — no link to test with');
  linkId = link.id;

  browser = await chromium.launch({ channel: 'chrome' });
  const page = await (await browser.newContext()).newPage();
  await page.goto(link.url.replace(/^https?:\/\/[^/]+/, B), { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-testid="pay-panel"]', { timeout: 25000 });
  const seen = (id) => page.locator(`[data-testid="${id}"]:visible`).count();

  check('the Pay button is offered', await seen('pay-start') === 1,
    'the predicate said yes, so the page renders it — that part was always right');

  // THE WORKAROUND IS GONE. This used to accept cookies before it could click, because the consent
  // bar covered the Pay button — 216px on desktop, 268px on a phone. That was a gate bending around
  // a real defect. The bar is now a strip whose height the page reserves, so the click needs no
  // dismissal and no force; scripts/consent-reach-gate owns that assertion at both viewports.
  check('the consent bar is up and not in the way', (await page.locator('[data-testid="consent-banner"]').count()) === 1,
    'still shown — this is the first visit for a fresh context');
  await page.click('[data-testid="pay-start"]');
  await page.waitForSelector('[data-testid="pay-error"]', { timeout: 30000 });
  const msg = (await page.locator('[data-testid="pay-error"]').textContent())?.trim();
  check('Stripe refuses the invalid key', !!msg, msg?.slice(0, 70));
  // THE FIX. Before this, the button stayed and the customer saw an offer beside its own denial.
  check('and the button is GONE — not sitting beside its own denial', await seen('pay-start') === 0,
    'a settled refusal replaces the offer; it does not annotate it');
  check('the reassurance about card details goes with it', !(await page.locator('[data-testid="pay-panel"]').textContent())?.includes('never reach the garage'),
    'no promises about a payment that is not going to happen');

  // ── 4. THE CONTRACT THE PANEL READS ────────────────────────────────────────────────────────
  console.log('\n— retryable rides on every answer —');
  const raw = link.url.split('/').pop().split('?')[0];
  const resp = await page.evaluate(async ([b, t]) => {
    const r = await fetch(`${b}/api/pay/intent`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: t }) });
    return { status: r.status, body: await r.json().catch(() => ({})) };
  }, [B, raw]);
  check('the refusal carries retryable explicitly', resp.body.retryable === false,
    `${resp.status} ${resp.body.code} retryable=${resp.body.retryable}`);
  check('it is Stripe’s own classification, not a guess', resp.body.code === 'key_rejected',
    'an invalid key is StripeAuthenticationError → key_rejected, and the classifier says so');

  // A DOCUMENT refusal is settled too, and must say so — this is the path 100003205 would take
  // once its invoice is finally settled.
  const paid = await prisma.invoice.findFirst({ where: { group_id: ZZ, status: 'paid' }, select: { id: true } });
  if (paid) {
    const paidDoc = await buildInvoiceDoc(paid.id, ZZ);
    const r = refusePayment(paidDoc, 0);
    check('a settled invoice refuses on the DOCUMENT, before any configuration', r?.code === 'nothing_owing',
      'order matters: never "card payments aren’t switched on" about an invoice that is already paid');
  } else {
    check('a paid ZZ invoice exists to prove document-order', false, 'none — UNPROVEN');
  }
} catch (e) {
  check('run completed', false, String(e?.message ?? e).slice(0, 300));
} finally {
  await browser?.close().catch(() => {});
  if (linkId) {
    const d = await prisma.customerMagicLink.deleteMany({ where: { id: linkId } });
    check('teardown removed the gate’s pay link', d.count === 1, 'a real credential must not outlive the run');
  }
  if (connId) {
    const d = await prisma.providerConnection.deleteMany({ where: { id: connId } });
    check('teardown removed the fixture connection', d.count === 1);
  }
  const left = await prisma.providerConnection.count({ where: { group_id: ZZ } });
  check('ZZ has no connection row again', left === 0, `${left}`);
  const pays = await prisma.payment.count({ where: { group_id: ZZ, provider: 'stripe' } });
  check('and no payment was created anywhere on ZZ', pays === 0, `${pays} — the invalid key never got past Stripe`);
  const released = await prisma.authRateLimit.deleteMany({
    where: { key: { startsWith: 'pay:' }, created_at: { gte: startedAt } },
  });
  check('teardown cleared this run’s limiter budget', true, `${released.count} token(s) released`);
  console.log(`\n${out.filter((c) => c === 'F').length} failures of ${out.length}`);
  await prisma.$disconnect();
  process.exit(out.includes('F') ? 1 : 0);
}
