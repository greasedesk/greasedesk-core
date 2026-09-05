/**
 * File: scripts/free-tenant-gate.mjs
 * A TENANT THAT PAYS NOTHING IS NOT TOLD WHAT IT WILL BE CHARGED.
 * @gate-requires: server:3000, db
 *
 * ── THE DEFECT THIS STARTED FROM ────────────────────────────────────────────────────────────────
 * The dashboard banner refused on `is_demo` alone. ZZ Gate Garage is `is_internal` with a
 * hand-written `active` billing row and no subscription, so it fell through every branch to the
 * last one and read:
 *
 *     Subscribed — £75 per month
 *
 * lib/demo-tenant already names the question that branch meant to ask — `neverSubscribes`, "an
 * internal tenant has no subscription and never will" — and its header records that TWO readers had
 * already been found asking it through the wrong flag, both "by the tenant looking broken". The
 * banner was a third, and nobody had looked at ZZ's dashboard.
 *
 * ── AND FREE IS A DECISION, SO IT HAS AN AUTHOR AND A DATE ──────────────────────────────────────
 * `is_internal` means OURS. A garage we decide not to charge — a beta partner, a friend's shop, a
 * reseller's own workshop — is not ours, and a third boolean answering an adjacent question is
 * exactly how the first two flags went wrong. So `free_since` + `free_reason`: nullable, dated,
 * explained, and read through ONE named predicate beside neverSubscribes.
 *
 * ── THE GATE DRIVES THE BANNER, NOT THE PREDICATE ───────────────────────────────────────────────
 * A pure check on isFree() would have passed on the day the banner was wrong. So this signs in and
 * reads the rendered page in three states, and the THIRD is the one that makes the other two mean
 * anything: with every exemption removed the banner must SPEAK. "No money sentence" is true of a
 * blank page, a crashed tree and a tenant that never loaded.
 *
 * Fixtures on ZZ Gate Garage only. Never TMBS. ZZ's own flags are moved for the run and RESTORED,
 * asserted field by field in teardown.
 */
import './_gate-preflight.mjs';
const { gatePrisma, explainIfClientStale, serverReady, describeError } = await import('./_gate-preflight.mjs');
import './_ts.mjs';
const { chromium } = await import('/Users/hugh/Developer/greasedesk-core/node_modules/playwright-core/index.mjs');
const { readFileSync } = await import('node:fs');
const D = await import('../lib/demo-tenant.ts').catch(() => ({}));
const prisma = await gatePrisma();

const ZZ = 'c75ac44e-250a-4c90-98ba-a8326e98dad5';
const TMBS = '854d38e7-6dd4-4836-af61-a0d169639a78';
const BASE = process.env.GATE_BASE ?? 'http://localhost:3000';
const out = [];
const check = (n, ok, d = '') => { out.push(ok ? 'P' : 'F'); console.log(`${ok ? '✓' : '✗'} ${n}${d ? `  — ${d}` : ''}`); };
const prose = (src) => src.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
/** Every sentence the banner has about money. If any of these appears, it is talking about a bill. */
const MONEY = /per month|will then be charged|Subscribed|Resubscribe|add billing/i;
let fix = null, browser = null;

try {
  // ── 1. THE PREDICATE, BESIDE THE ONE IT JOINS ────────────────────────────────────────────────
  console.log('\n— free is a decision, with an author and a date —');
  check('lib/demo-tenant exports isFree', typeof D.isFree === 'function', `isFree=${typeof D.isFree}`);
  const f = (g) => { try { return D.isFree(g); } catch { return null; } };
  check('a dated decision is free', f({ free_since: new Date('2026-09-05') }) === true);
  check('  …and a tenant with none is not', f({ free_since: null }) === false);
  check('  …and neither is an empty object — absence never grants it', f({}) === false && f(null) === false,
    'the same rule neverSubscribes follows: absence is not an exemption');
  // A REASON WITHOUT A DATE IS NOT A DECISION. The date is what makes it one.
  check('  …a reason alone does not make a tenant free', f({ free_reason: 'because I said so' }) === false,
    'free_since is the decision; free_reason explains it');

  check('neverSubscribes now covers free', D.neverSubscribes?.({ free_since: new Date() }) === true,
    'a free tenant has no subscription and never will — the sentence that predicate already carries');
  check('  …without disturbing what it already covered',
    D.neverSubscribes?.({ is_demo: true }) === true && D.neverSubscribes?.({ is_internal: true }) === true
    && D.neverSubscribes?.({ is_demo: false, is_internal: false }) === false);

  const schema = readFileSync('prisma/schema.prisma', 'utf8');
  check('both columns are nullable and dated', /free_since\s+DateTime\?/.test(schema) && /free_reason\s+String\?/.test(schema));

  // ── 2. THE BANNER ASKS THE RIGHT QUESTION ────────────────────────────────────────────────────
  const dash = prose(readFileSync('pages/admin/dashboard.tsx', 'utf8'));
  check('the banner refuses on neverSubscribes, not is_demo', /neverSubscribes\(/.test(dash),
    'is_demo answers "never send messages from here", which is a different question');

  // ── 3. THE FIXTURES ──────────────────────────────────────────────────────────────────────────
  const before = await prisma.group.findUnique({ where: { id: ZZ },
    select: { is_demo: true, is_internal: true, free_since: true, free_reason: true } });
  fix = { before };

  const ready = await serverReady();
  check('the dev server serves pages before we drive it', ready.ok, `HTTP ${ready.status} after ${ready.attempts} attempt(s)`);
  browser = await chromium.launch({ channel: 'chrome' });
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 1600 } })).newPage();
  await page.goto(`${BASE}/admin/login`, { waitUntil: 'domcontentloaded' });
  await page.fill('input[type="email"]', 'owner@zzgategarage.test');
  await page.fill('input[type="password"]', 'GateGarage!2026');
  await Promise.all([page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 60000 }), page.click('button[type="submit"]')]);

  /**
   * Load the dashboard fresh and return what a person would read.
   *
   * IT WAITS FOR SOMETHING BELOW THE BANNER. The banner is server-rendered, but the tiles arrive
   * later, and reading innerText early would let "no money sentence" pass simply because the page
   * had not finished — the silent reads came back 2,025 characters against 6,051 for the speaking
   * one, which is exactly the gap that hides a premature read. The revenue figure sits after the
   * banner in the DOM, so its presence means the banner region has definitely rendered.
   */
  const readBanner = async () => {
    await page.goto(`${BASE}/admin/dashboard`, { waitUntil: 'domcontentloaded' });
    const settled = await page.waitForSelector('[data-testid="revenue-figure"], [data-testid="dash-no-data"]', { timeout: 30000 })
      .then(() => true).catch(() => false);
    await page.waitForTimeout(400);
    return { text: await page.evaluate(() => document.body.innerText), settled };
  };

  // ── 4. THE STATE THAT WAS WRONG TODAY ────────────────────────────────────────────────────────
  console.log('\n— an internal tenant is not told what it will be charged —');
  await prisma.group.update({ where: { id: ZZ }, data: { free_since: null, free_reason: null } });
  const asInternalR = await readBanner();
  const asInternal = asInternalR.text;
  // POSITIVE FIRST. "No money sentence" is true of a blank page, so the page must have rendered.
  check('the dashboard rendered PAST the banner', asInternalR.settled && /Dashboard/i.test(asInternal),
    `settled=${asInternalR.settled}, ${asInternal.length} chars — the nav word alone appears before the banner does`);
  check('  …and says nothing about a subscription', !MONEY.test(asInternal),
    (asInternal.match(MONEY) ?? ['none'])[0] + ' — ZZ read "Subscribed — £75 per month" before this');

  // ── 5. FREE ALONE IS ENOUGH ──────────────────────────────────────────────────────────────────
  // is_internal removed, so the ONLY thing exempting this tenant is the free decision.
  console.log('\n— and neither is a tenant we simply do not charge —');
  await prisma.group.update({ where: { id: ZZ },
    data: { is_internal: null, free_since: new Date(), free_reason: 'Gate fixture: proving free alone silences the banner' } });
  const asFreeR = await readBanner();
  const asFree = asFreeR.text;
  check('the dashboard rendered PAST the banner', asFreeR.settled && /Dashboard/i.test(asFree),
    `settled=${asFreeR.settled}, ${asFree.length} chars`);
  check('  …and free alone silences it', !MONEY.test(asFree),
    (asFree.match(MONEY) ?? ['none'])[0] + ' — is_internal is cleared here; only free_since remains');

  // ── 6. THE DISCRIMINATING CASE ───────────────────────────────────────────────────────────────
  // Without this the two checks above pass against a banner that never renders anything at all.
  console.log('\n— and with no exemption at all it DOES speak —');
  await prisma.group.update({ where: { id: ZZ }, data: { is_internal: null, free_since: null, free_reason: null } });
  const asPayingR = await readBanner();
  const asPaying = asPayingR.text;
  check('the dashboard rendered PAST the banner', asPayingR.settled && /Dashboard/i.test(asPaying),
    `settled=${asPayingR.settled}, ${asPaying.length} chars`);
  check('  …and the banner talks about money', MONEY.test(asPaying),
    'if this passes silently the two checks above prove nothing');

  // ── 7. THE TENANTS THIS SLICE SET FREE ───────────────────────────────────────────────────────
  console.log('\n— and the two tenants it was built for —');
  for (const [ref, id] of [['GB-GD1967 TMBS', TMBS], ['US-GD2175 ZZUS', null]]) {
    const g = id
      ? await prisma.group.findUnique({ where: { id }, select: { free_since: true, free_reason: true, is_internal: true } })
      : await prisma.group.findFirst({ where: { ref: 'US-GD2175' }, select: { free_since: true, free_reason: true, is_internal: true } });
    check(`${ref} is free`, !!g?.free_since, String(g?.free_since));
    check(`  …with a reason somebody wrote`, (g?.free_reason ?? '').trim().length >= 12, g?.free_reason ?? '(none)');
  }
  // EXPLICITLY NOT INTERNAL. TMBS carries 303 job cards and every golden figure; taking it out of
  // counts, forecast and revenue is a separate decision nobody has made.
  const tmbs = await prisma.group.findUnique({ where: { id: TMBS }, select: { is_internal: true } });
  check('TMBS is free but NOT internal', tmbs?.is_internal !== true,
    `is_internal=${tmbs?.is_internal} — free says "pays nothing", internal says "ours", and they are different claims`);
} catch (e) {
  check('gate run completed', false, describeError(e).slice(0, 300));
  await explainIfClientStale(BASE);
} finally {
  if (browser) await browser.close().catch(() => {});
  if (fix) {
    // RESTORED FIELD BY FIELD, and asserted. This gate moves flags on a standing tenant; leaving
    // one moved would change what ZZ counts towards without anybody noticing.
    try {
      await prisma.group.update({ where: { id: ZZ }, data: {
        is_demo: fix.before.is_demo, is_internal: fix.before.is_internal,
        free_since: fix.before.free_since, free_reason: fix.before.free_reason } });
    } catch (e) { console.log(`  teardown zz flags: ${describeError(e).slice(0, 90)}`); }
    const now = await prisma.group.findUnique({ where: { id: ZZ },
      select: { is_demo: true, is_internal: true, free_since: true, free_reason: true } });
    check('teardown restored every ZZ flag',
      now?.is_demo === fix.before.is_demo && now?.is_internal === fix.before.is_internal
      && String(now?.free_since) === String(fix.before.free_since)
      && now?.free_reason === fix.before.free_reason,
      `${JSON.stringify(now)} vs ${JSON.stringify(fix.before)}`);
  }
}

console.log(`\n${out.filter((x) => x === 'F').length} failures of ${out.length}`);
await prisma.$disconnect();
process.exit(out.includes('F') ? 1 : 0);
