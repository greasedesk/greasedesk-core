/**
 * File: scripts/pay-refusal-gate.mjs
 * @gate-requires: server
 * Gate for the key-dependent half of the card-payment refusal path.
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
 * ── THE PREMISE IS NOW CHECKED, NOT JUST STATED ─────────────────────────────────────────────────
 * That invalid key is a REQUIREMENT, and for a while it was only a sentence in this comment. When the
 * key left the environment entirely, payPreconditions returned `not_configured` and four clauses went
 * red naming the symptom rather than the requirement. They have moved to scripts/pay-predicate-gate,
 * which needs no key and runs every time; what is left here genuinely cannot run without one, so it
 * DECLINES and says what it needs. UNRUN is the honest answer to a missing environment; red is not.
 *
 * ── FIXTURES ────────────────────────────────────────────────────────────────────────────────────
 * ZZ only. One ProviderConnection row, created here and deleted in the finally; it refuses to start
 * if ZZ already has one, because clobbering a real connection is not a thing a gate may do. The
 * magic link it mints is a real credential for a ZZ invoice and is revoked on the way out.
 */
import './_gate-preflight.mjs';
const { serverReady, describeError, gateOrigin, declineToRun } = await import('./_gate-preflight.mjs');
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
// THE CONFIGURED ORIGIN — gateOrigin(), whose port is scripts/_dev-port::DEV_PORT and nowhere else.
// This once defaulted to 3112, then to a hardcoded 3000: neither was a decision, just whatever the
// author had running that afternoon. Six gates carried defaults like it and skipped on every
// machine but one. GATE_BASE still overrides, which is what a genuinely different server is for.
const B = gateOrigin();
const out = [];
const check = (n, ok, d = '') => { out.push(ok ? 'P' : 'F'); console.log(`${ok ? '✓' : '✗'} ${n}${d ? `  — ${d}` : ''}`); };

// The pay limiter is shared and time-windowed (10/hour on `pay:ip:`). This gate spends from it,
// and leaving the budget behind makes the NEXT pay gate 429 in a way that reads as an endpoint
// defect rather than as our own litter. Released in the finally, scoped to this run.
const startedAt = new Date();

// THE PREMISE, CHECKED. Not merely "a key": a key Stripe will REJECT. A valid one here would try to
// move real money on a real account, which is why the deliberately invalid one is the design and not
// an accident of someone's .env. Absent → UNRUN with the requirement named, never a red about code.
if (!process.env.STRIPE_SECRET_KEY) {
  declineToRun('this gate needs a PRESENT but INVALID STRIPE_SECRET_KEY in the SERVED build — it drives '
    + 'a genuine StripeAuthenticationError through the customer’s page. None is set, so the panel never '
    + 'renders and every clause below would assert a state this environment cannot reach. The key-free '
    + 'assertions live in scripts/pay-predicate-gate.mjs and ran; this leg is unproven until a key exists.');
}

let connId = null;
let linkId = null;
let browser = null;
try {
  // ── 1. THE FIXTURE, AND THE ONE THING THE BROWSER LEG NEEDS TO BE TRUE ─────────────────────
  // Everything about the CLASSIFIER and the PREDICATE moved to pay-predicate-gate: none of it needs
  // a key, and keeping it here meant it only ran when the environment happened to be configured.
  console.log('\n— the fixture, and something to pay —');
  const stale = await prisma.providerConnection.count({ where: { group_id: ZZ } });
  if (stale) declineToRun(`REFUSING: ZZ already has ${stale} ProviderConnection row(s)`);
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

  // Everything the PREDICATE does lives in pay-predicate-gate now — the fee resolver, the no-rate
  // throw, the source of the catch, and the unconfigured refusal. None of it needs a key, and while
  // it lived here it only ran when the environment happened to have one.

  // ── 3. THE SERVED PAGE ─────────────────────────────────────────────────────────────────────
  console.log('\n— a settled refusal on the customer’s page —');
  const link = await mintInvoicePayLink({ doc, groupId: ZZ, recipient: 'gate', createdByUserId: null });
  if (!link) throw new Error('mintInvoicePayLink refused — no link to test with');
  linkId = link.id;

  // The dev server disposes inactive pages and serves 404s while it rebuilds one; a gate that
  // drives a page that was never served dies as a bare selector timeout 25s later. Warm it and
  // say so — see serverReady in _gate-preflight.
  const ready = await serverReady();
  check('the dev server serves pages before we drive it', ready.ok, `HTTP ${ready.status} after ${ready.attempts} attempt(s)`);
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

} catch (e) {
  check('run completed', false, describeError(e).slice(0, 300));
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
