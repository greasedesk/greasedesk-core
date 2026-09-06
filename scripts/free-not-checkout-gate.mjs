/**
 * File: scripts/free-not-checkout-gate.mjs
 * A TENANT THAT WILL NEVER PAY IS NEVER SENT TO CHECKOUT.
 * @gate-requires: server:3000, db
 *
 * ── THE DEFECT THIS STARTED FROM, AND WHO CAUSED IT ─────────────────────────────────────────────
 * TMBS was set free on 5 September. On 6 September at 07:25 a script nulled its stranded Stripe
 * pointers — ids belonging to a platform account retired on 6 August, which nothing could refresh.
 * That was correct. What was NOT checked is that `subscription_status` had a THIRD reader.
 *
 * lib/onboarding step (F) requires subscription_status ∈ {trialing, active, past_due}. The stale
 * `trialing` written by the retired account's last webhook was the only thing satisfying it. Null it
 * and the root gate — which runs on the dashboard, landing, job cards and quotes — begins redirecting
 * every admin page to /onboarding/billing. A card was added 27 minutes later.
 *
 * The clearing script's header claimed NULL was safe because "canWrite returns true for no
 * subscription, and billingGate has no anchor so the phase stays ok". Both true. Two readers checked,
 * a conclusion drawn about all of them, and the third decides whether the product opens at all.
 *
 * ── THE PREDICATE WAS RIGHT AND THE ROWS WERE STARVED ───────────────────────────────────────────
 * neverSubscribes has handled free_since since 5 September. But TWO of its three callers select the
 * row WITHOUT that column, so isFree reads `undefined` and returns false. The call site reads
 * correctly and is silently blind — which is harder to see than a wrong flag, because there is
 * nothing wrong to see at the point of call.
 *
 * So every check below runs the REAL reader against a REAL row from the database. A pure-function
 * check on neverSubscribes({free_since}) passes today and proves nothing about either caller.
 *
 * ── WHAT THIS GATE CANNOT DRIVE, AND WHY IT SAYS SO ─────────────────────────────────────────────
 * The checkout REFUSAL is asserted against refuseDemoBilling directly, not over HTTP. There is no
 * STRIPE_SECRET_KEY in this environment, and /api/stripe/checkout returns 503 from getStripe()
 * BEFORE it reaches the guard — so an HTTP leg here would return 503 red and 503 green and assert
 * nothing while looking like proof. The guard itself needs no key and is exercised in full.
 * (That ordering is worth its own look: an unconfigured environment tells a free tenant "billing
 * isn't configured" rather than "you have nothing to buy".)
 *
 * The REDIRECT is driven in a browser, because the redirect is what a person hits.
 *
 * Fixtures on ZZ Gate Garage only. Never TMBS. Four fields move — is_internal, free_since,
 * free_reason and billing.subscription_status — and all four are restored and asserted in teardown.
 */
import './_gate-preflight.mjs';
const { gatePrisma, explainIfClientStale, serverReady, describeError } = await import('./_gate-preflight.mjs');
import './_ts.mjs';
const { chromium } = await import('/Users/hugh/Developer/greasedesk-core/node_modules/playwright-core/index.mjs');
const D = await import('../lib/demo-tenant.ts').catch(() => ({}));
const O = await import('../lib/onboarding.ts').catch(() => ({}));
const S = await import('../lib/setup-signals.ts').catch(() => ({}));
const prisma = await gatePrisma();

const ZZ = 'c75ac44e-250a-4c90-98ba-a8326e98dad5';
const BASE = process.env.GATE_BASE ?? 'http://localhost:3000';
const out = [];
const check = (n, ok, d = '') => { out.push(ok ? 'P' : 'F'); console.log(`${ok ? '✓' : '✗'} ${n}${d ? `  — ${d}` : ''}`); };
const MONEY = /per month|will then be charged|Subscribed|Resubscribe|add billing/i;
let fix = null, browser = null;

/** The three states ZZ is driven through. PAYING is what makes FREE mean anything. */
const asFree = { is_internal: null, free_since: new Date(), free_reason: 'Gate fixture: free tenants are never sent to Checkout' };
const asPaying = { is_internal: null, free_since: null, free_reason: null };

try {
  const before = await prisma.group.findUnique({ where: { id: ZZ },
    select: { is_demo: true, is_internal: true, free_since: true, free_reason: true } });
  const beforeBilling = await prisma.groupBilling.findUnique({ where: { group_id: ZZ },
    select: { subscription_status: true } });
  fix = { before, beforeBilling };

  // NO SUBSCRIPTION for the whole run. ZZ carries a hand-written `active` status, which would
  // satisfy step (F) on its own and hide exactly the branch under test.
  await prisma.groupBilling.update({ where: { group_id: ZZ }, data: { subscription_status: null } });

  // ── 1. THE READERS, EACH GIVEN A REAL ROW ────────────────────────────────────────────────────
  console.log('\n— the predicate reaches every reader that asks it —');
  await prisma.group.update({ where: { id: ZZ }, data: asFree });

  const gns = await D.groupNeverSubscribes?.(ZZ).catch(() => null);
  check('groupNeverSubscribes sees a free tenant', gns === true, String(gns));

  const st = await O.getOnboardingState?.(ZZ).catch(() => null);
  check('the onboarding gate does not send a free tenant to checkout', st?.onboarded === true,
    JSON.stringify(st));

  const sig = await S.getSetupSignals?.(ZZ, null).catch(() => null);
  const subSignal = sig?.signals?.find((s) => s.key === 'subscription');
  check('the setup nag counts the subscription signal done', subSignal?.state === 'done',
    `state=${subSignal?.state}`);

  const freeRes = { code: null, body: null,
    status(c) { this.code = c; return { json: (b) => { this.body = b; } }; } };
  const refusedFree = await D.refuseDemoBilling?.(freeRes, ZZ).catch(() => null);
  check('refuseDemoBilling refuses a free tenant', refusedFree === true, String(refusedFree));
  check('  …with 403 and a code the client can branch on',
    freeRes.code === 403 && freeRes.body?.code === 'free_tenant',
    `${freeRes.code} ${JSON.stringify(freeRes.body)}`);

  // ── 2. THE DISCRIMINATING CASE ───────────────────────────────────────────────────────────────
  // Without these, every check above passes against a function that says "exempt" to everybody.
  console.log('\n— and a tenant with no exemption is still sent there —');
  await prisma.group.update({ where: { id: ZZ }, data: asPaying });

  const gnsPaying = await D.groupNeverSubscribes?.(ZZ).catch(() => null);
  check('groupNeverSubscribes does NOT exempt a paying tenant', gnsPaying === false, String(gnsPaying));

  const stPaying = await O.getOnboardingState?.(ZZ).catch(() => null);
  check('the onboarding gate DOES send it to checkout', stPaying?.firstIncompleteStep === 'checkout',
    JSON.stringify(stPaying));

  const sigPaying = await S.getSetupSignals?.(ZZ, null).catch(() => null);
  check('the setup nag leaves its subscription signal outstanding',
    sigPaying?.signals?.find((s) => s.key === 'subscription')?.state === 'todo',
    String(sigPaying?.signals?.find((s) => s.key === 'subscription')?.state));

  const payRes = { code: null, body: null,
    status(c) { this.code = c; return { json: (b) => { this.body = b; } }; } };
  const refusedPaying = await D.refuseDemoBilling?.(payRes, ZZ).catch(() => null);
  check('refuseDemoBilling does NOT refuse a paying tenant', refusedPaying === false,
    `${refusedPaying} ${payRes.code ?? 'no response written'}`);

  // ── 3. THE REDIRECT, THE WAY A PERSON HITS IT ────────────────────────────────────────────────
  const ready = await serverReady();
  check('the dev server serves pages before we drive it', ready.ok, `HTTP ${ready.status} after ${ready.attempts} attempt(s)`);
  browser = await chromium.launch({ channel: 'chrome' });
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 1600 } })).newPage();
  await page.goto(`${BASE}/admin/login`, { waitUntil: 'domcontentloaded' });
  await page.fill('input[type="email"]', 'owner@zzgategarage.test');
  await page.fill('input[type="password"]', 'GateGarage!2026');
  await Promise.all([page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 60000 }), page.click('button[type="submit"]')]);

  const openDashboard = async () => {
    await page.goto(`${BASE}/admin/dashboard`, { waitUntil: 'domcontentloaded' });
    const settled = await page.waitForSelector('[data-testid="revenue-figure"], [data-testid="dash-no-data"]', { timeout: 30000 })
      .then(() => true).catch(() => false);
    await page.waitForTimeout(400);
    return { url: page.url(), text: await page.evaluate(() => document.body.innerText), settled };
  };

  // THE STATE THE BROWSER IS STILL IN IS `asPaying` — assert the redirect FIRST, so a free tenant
  // reaching the dashboard afterwards cannot be explained by the gate never redirecting at all.
  console.log('\n— a tenant with no exemption and no subscription is redirected —');
  const paying = await openDashboard();
  check('the dashboard redirects to Checkout', /\/onboarding\/billing/.test(paying.url), paying.url);

  console.log('\n— and a free tenant reaches its own dashboard —');
  await prisma.group.update({ where: { id: ZZ }, data: asFree });
  const free = await openDashboard();
  check('it is NOT redirected to Checkout', !/\/onboarding\//.test(free.url), free.url);
  check('  …it is on the dashboard', /\/admin\/dashboard/.test(free.url), free.url);
  // POSITIVE. "Not redirected" is true of a crashed page and of a 500.
  check('  …and the dashboard actually rendered', free.settled && /Dashboard/i.test(free.text),
    `settled=${free.settled}, ${free.text.length} chars`);
  check('  …and still says nothing about money', !MONEY.test(free.text),
    (free.text.match(MONEY) ?? ['none'])[0]);
} catch (e) {
  check('gate run completed', false, describeError(e).slice(0, 300));
  await explainIfClientStale(BASE);
} finally {
  if (browser) await browser.close().catch(() => {});
  if (fix) {
    try {
      await prisma.group.update({ where: { id: ZZ }, data: {
        is_demo: fix.before.is_demo, is_internal: fix.before.is_internal,
        free_since: fix.before.free_since, free_reason: fix.before.free_reason } });
      await prisma.groupBilling.update({ where: { group_id: ZZ },
        data: { subscription_status: fix.beforeBilling?.subscription_status ?? null } });
    } catch (e) { console.log(`  teardown: ${describeError(e).slice(0, 90)}`); }
    const now = await prisma.group.findUnique({ where: { id: ZZ },
      select: { is_demo: true, is_internal: true, free_since: true, free_reason: true } });
    const nowBilling = await prisma.groupBilling.findUnique({ where: { group_id: ZZ },
      select: { subscription_status: true } });
    check('teardown restored every ZZ field',
      now?.is_demo === fix.before.is_demo && now?.is_internal === fix.before.is_internal
      && String(now?.free_since) === String(fix.before.free_since)
      && now?.free_reason === fix.before.free_reason
      && nowBilling?.subscription_status === fix.beforeBilling?.subscription_status,
      `${JSON.stringify(now)} ${JSON.stringify(nowBilling)} vs ${JSON.stringify(fix.before)} ${JSON.stringify(fix.beforeBilling)}`);
  }
}

console.log(`\n${out.filter((x) => x === 'F').length} failures of ${out.length}`);
await prisma.$disconnect();
process.exit(out.includes('F') ? 1 : 0);
