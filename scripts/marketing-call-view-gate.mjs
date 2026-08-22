// @gate-timeout: 180
/**
 * File: scripts/marketing-call-view-gate.mjs
 * THE CALL VIEW — the three panes a garage rings a customer from.
 *
 * What this protects is a screen somebody reads ALOUD down a phone. Every rule here failed at least
 * once before it was written down: the middle pane rendered eight pixels wide, a finding said what
 * needed doing and never when, a battery description that already said "Replace." acquired a second
 * answer, and twenty tread readings sat in the database while the caller had nothing to quote.
 *
 * ── WHY THIS GATE ASSERTS EVERY SELECTOR IS UNIQUE BEFORE IT USES ONE ──────────────────────────
 * This gate exists partly BECAUSE of a false reading it would otherwise have repeated. The content
 * div inside each pane carried the same `data-testid` as the <section> framing it, so two elements
 * answered to `pane-history`. Playwright's strict mode throws on an ambiguous locator — and a probe
 * that wrote `.isVisible().catch(() => false)` turned that throw into `false`, reporting a hidden
 * pane on a layout that was correct. Half an hour went to debugging working code.
 *
 * Three rules follow, and they are the point of the file as much as any assertion below:
 *   1. TESTIDS ARE COUNTED FIRST. `preflight()` walks every selector this gate will use and fails
 *      loudly if any resolves to a number other than one. A duplicate testid is now a RED GATE with
 *      the id named, not a silently inverted boolean somewhere further down.
 *   2. NOTHING IS CAUGHT. There is no `.catch()` on a locator call anywhere in this file. A strict
 *      -mode violation must reach the top and fail the run; swallowing it is what caused the harm.
 *   3. VISIBILITY IS READ THROUGH `one()`, which re-counts at the point of use, because a pane can
 *      gain a second element with the same id long after this header stops being read.
 *
 * ── @gate-timeout: 180 — BELOW THE 300s DEFAULT, DELIBERATELY ──────────────────────────────────
 * Measured at 15.8s warm on 2026-08-22: two cars, seven page loads, five viewport changes and a
 * browser launch. 180s is eleven times that, which covers the first hit of a cold run compiling
 * /admin/marketing and several browser gates competing for the same cores. It is set BELOW the
 * default rather than above it because a browser gate that stops responding should be killed in
 * three minutes, not five — the runner counts a hang as a failure, and a faster verdict is a
 * better one. Raise it if the fixture set grows, and re-measure rather than guessing.
 *
 * Fixtures on ZZ Gate Garage only. Never TMBS.
 */
import './_gate-preflight.mjs';
import './_ts.mjs';
const { PrismaClient } = await import('@prisma/client');
const { chromium } = await import('playwright-core');
const T = await import('../lib/tyres.ts');
const BAT = await import('../lib/battery.ts');
const prisma = new PrismaClient();

const ZZ = 'c75ac44e-250a-4c90-98ba-a8326e98dad5';
const CUST = 'Call View Fixture Holder';
const REGS = ['ZZ76CVA', 'ZZ76CVB'];
const BASE = process.env.GATE_BASE ?? 'http://localhost:3000';

// Descriptions chosen to appear NOWHERE else — not in the app, not in this gate's own prose, not in
// each other. A search term that its own fixture also matches is how two correct checks were
// defeated in one day; these are counted against the page, never assumed.
const F_MILEAGE = 'Nearside sill corrosion starting';
const F_SERVICE = 'Gearbox mount perished';
const F_OWNTIME = 'Auxiliary belt cracking — renew before the winter.';

const out = [];
const check = (n, ok, d = '') => { out.push(ok ? 'P' : 'F'); console.log(`${ok ? '✓' : '✗'} ${n}${d ? `  — ${d}` : ''}`); };
let fix = null, browser = null, page = null;

/**
 * ONE ELEMENT OR NOTHING. Returns the locator only when exactly one node matches; more than one is
 * an ERROR, never a falsy answer. Zero is reported as absent, which is a legitimate state this gate
 * asserts in both directions — but two is always a bug in the page or in this gate.
 */
async function one(sel) {
  const loc = page.locator(sel);
  const n = await loc.count();
  if (n > 1) throw new Error(`AMBIGUOUS SELECTOR ${sel} matched ${n} elements — the strict-mode swallow this gate exists to prevent`);
  return n === 1 ? loc : null;
}
const visible = async (sel) => { const l = await one(sel); return l ? l.isVisible() : false; };
const widthOf = async (sel) => {
  const l = await one(sel);
  if (!l || !(await l.isVisible())) return null;
  const b = await l.boundingBox();
  return b ? Math.round(b.width) : null;
};
const textOf = async (sel) => { const l = await one(sel); return l ? (await l.innerText()).replace(/\s+/g, ' ') : null; };

try {
  const stale = await prisma.vehicle.count({ where: { group_id: ZZ, registration: { in: REGS } } });
  if (stale) throw new Error(`REFUSING: ${stale} fixture vehicle(s) from a previous run still present`);

  const site = await prisma.site.findFirst({ where: { group_id: ZZ }, select: { id: true } });
  if (!site) throw new Error('REFUSING: ZZ Gate Garage has no site');
  const cust = await prisma.customer.create({ data: { group_id: ZZ, name: CUST }, select: { id: true } });
  fix = { cust: cust.id, vehs: [], cards: [] };

  const mkCar = async (reg) => {
    const v = await prisma.vehicle.create({ data: { group_id: ZZ, registration: reg,
      registration_normalized: reg, make: 'Callview', model: 'Fixture' }, select: { id: true } });
    await prisma.vehicleOwnership.create({ data: { vehicle_id: v.id, customer_id: cust.id, is_current: true } });
    fix.vehs.push(v.id);
    return v.id;
  };
  const mkCard = async (vehId, odo, when) => {
    const c = await prisma.jobCard.create({ data: { group_id: ZZ, site_id: site.id, vehicle_id: vehId,
      customer_id: cust.id, status: 'draft', odometer_in: odo, created_at: when }, select: { id: true } });
    fix.cards.push(c.id);
    return c.id;
  };
  const mkFinding = (vehId, cardId, d) => prisma.vehicleDueItem.create({ data: {
    group_id: ZZ, vehicle_id: vehId, found_on_job_card_id: cardId, customer_response: 'not_raised',
    created_by: 'call-view-gate', ...d } });

  // ── CAR A: TWO VISITS, AND THE NEWER ONE NEVER KEYED A MILEAGE ───────────────────────────────
  // The shape that decides between "the latest reading we hold" and "the latest card's column". A
  // car booked in and not yet driven onto the ramp has a card with no odometer on it; reading the
  // newest CARD gives null and quietly demotes every overdue finding to a plain target.
  const A = await mkCar(REGS[0]);
  const aOld = await mkCard(A, 79_200, new Date('2026-06-02T09:00:00Z'));
  const aNew = await mkCard(A, null, new Date('2026-08-03T09:00:00Z'));
  await mkFinding(A, aOld, { description: F_MILEAGE, due_basis: 'mileage', due_mileage: 78_000,
    timing_in_description: false, observation_key: null });
  await mkFinding(A, aOld, { description: F_SERVICE, due_basis: 'next_service',
    timing_in_description: false, observation_key: null });
  await mkFinding(A, aOld, { description: F_OWNTIME, due_basis: 'next_service',
    timing_in_description: true, observation_key: null });
  // Through the real recorders, not raw creates: these also raise their own advisories, and the
  // pane must stay right on a car whose findings it did not author.
  await prisma.$transaction((tx) => T.recordTyreReadings(tx, { groupId: ZZ, vehicleId: A, jobCardId: aOld,
    measuredBy: null, odometer: 79_200, corners: [
      { corner: 'front_left',  type: 'summer_standard', depths: { outer: 61, centre: 58, inner: 55 } },
      { corner: 'front_right', type: 'summer_standard', depths: { outer: 60, centre: 45, inner: 22 } },
      { corner: 'rear_left',   type: 'summer_standard', depths: { outer: 15, centre: 14, inner: 14 } },
      { corner: 'rear_right',  type: 'summer_standard', depths: { outer: 33, centre: 32, inner: 31 } },
    ] }));
  await prisma.$transaction((tx) => BAT.recordBatteryReading(tx, { groupId: ZZ, vehicleId: A, jobCardId: aOld,
    measuredBy: null, reading: { voltageMv: 12_340, socPct: 53, sohPct: 71, ratedCca: 700, ccaStandard: 'EN' },
    measuredAt: new Date('2026-06-02T10:00:00Z') }));

  // ── CAR B: NEVER MEASURED, NEVER READ ────────────────────────────────────────────────────────
  const Bv = await mkCar(REGS[1]);
  const bCard = await mkCard(Bv, null, new Date('2026-07-07T09:00:00Z'));
  await mkFinding(Bv, bCard, { description: F_MILEAGE, due_basis: 'mileage', due_mileage: 78_000,
    timing_in_description: false, observation_key: null });

  browser = await chromium.launch({ channel: 'chrome' });
  page = await (await browser.newContext({ viewport: { width: 1400, height: 900 } })).newPage();
  await page.goto(`${BASE}/admin/login`, { waitUntil: 'domcontentloaded' });
  await page.fill('input[type="email"]', 'owner@zzgategarage.test');
  await page.fill('input[type="password"]', 'GateGarage!2026');
  await Promise.all([page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 60000 }), page.click('button[type="submit"]')]);

  /**
   * NAVIGATE AND WAIT ON THE NETWORK, NEVER ON A TESTID THIS GATE IS ABOUT TO JUDGE.
   *
   * Waiting for `car-history` to appear made the gate unable to report its own headline defect:
   * renaming that id back to the frame's — the exact duplicate this file exists to catch — meant
   * the wait timed out and the run aborted BEFORE the preflight that names it. A check that cannot
   * run when the thing it checks for is present is not a check. The endpoint's response is the
   * honest signal that the pane has its data, and it is independent of every id under test.
   */
  const gotoCar = async (id, reg, extra = '') => {
    await Promise.all([
      page.waitForResponse((r) => r.url().includes('/api/marketing-car'), { timeout: 30000 }),
      page.goto(`${BASE}/admin/marketing?vehicle=${id}${extra}`, { waitUntil: 'domcontentloaded' }),
    ]);
    // ARRIVAL IS NOT RENDER. A fixed settle after the response passed on a quiet machine and failed
    // once under load, reporting an empty detail pane as a product defect — the fetch had landed and
    // React had not yet committed. The heading is `detail?.vehicle.registration ?? 'Loading…'`, so
    // it carrying the registration IS the state being populated: the condition itself, not a guess
    // at how long it takes. A gate that is right nine times in ten is not a gate.
    await page.waitForFunction(
      (r) => document.querySelector('h1')?.textContent?.includes(r) === true, reg, { timeout: 30000 });
  };
  await page.setViewportSize({ width: 1400, height: 900 });
  await gotoCar(A, REGS[0]);

  // ── 0. NO SELECTOR THIS GATE USES MAY MATCH TWICE ────────────────────────────────────────────
  // Counted, not assumed, and counted BEFORE anything is read through them. The duplicate that
  // caused the original false reading would fail here, by name, with nothing else going red.
  console.log('\n— every selector resolves to exactly one element —');
  const SELECTORS = ['[data-testid="pane-list"]', '[data-testid="pane-history"]', '[data-testid="pane-detail"]',
    '[data-testid="car-history"]', '[data-testid="car-detail"]', '[data-testid="readings"]',
    '[data-testid="readings-tyres"]', '[data-testid="readings-battery"]', '[data-testid="findings-unanswered"]',
    '[data-testid="call-view"]', '[data-testid="close-car"]'];
  const counts = {};
  for (const s of SELECTORS) counts[s] = await page.locator(s).count();
  const dupes = SELECTORS.filter((s) => counts[s] > 1);
  check('no testid answers for two elements', dupes.length === 0,
    dupes.map((s) => `${s}=${counts[s]}`).join(', ') || 'all 0 or 1');

  // ── 1. THE BREAKPOINT ────────────────────────────────────────────────────────────────────────
  // 1279 and 1280, because the whole defect lived in one pixel of difference. Both outer panes are
  // shrink-0, so below xl the middle one is starved rather than merely narrow.
  console.log('\n— three panes only when three panes fit —');
  await page.setViewportSize({ width: 1279, height: 900 });
  await page.waitForTimeout(300);
  const at1279 = { list: await widthOf('[data-testid="pane-list"]'),
                   history: await widthOf('[data-testid="pane-history"]'),
                   detail: await widthOf('[data-testid="pane-detail"]') };
  check('at 1279 only the list renders', at1279.list > 0 && at1279.history === null && at1279.detail === null,
    JSON.stringify(at1279));
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.waitForTimeout(300);
  const at1280 = { list: await widthOf('[data-testid="pane-list"]'),
                   history: await widthOf('[data-testid="pane-history"]'),
                   detail: await widthOf('[data-testid="pane-detail"]') };
  check('at 1280 all three render', at1280.list > 0 && at1280.history > 0 && at1280.detail > 0,
    JSON.stringify(at1280));
  check('  …and the middle pane is legible, not a sliver', at1280.history >= 240,
    `history is ${at1280.history}px — at lg it was 8px, which is what this number is here to stop`);

  // ── 2. THE TIMING SENTENCE ───────────────────────────────────────────────────────────────────
  console.log('\n— a finding says what, and when —');
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.waitForTimeout(300);
  const rowFor = async (needle) => {
    const li = page.locator('[data-testid="findings-unanswered"] li', { hasText: needle });
    const n = await li.count();
    if (n > 1) throw new Error(`AMBIGUOUS FIXTURE: "${needle}" matched ${n} finding rows`);
    if (n === 0) return null;
    return { text: (await li.innerText()).replace(/\s+/g, ' '),
             timings: await li.locator('[data-testid^="finding-timing-"]').count() };
  };
  const mileage = await rowFor(F_MILEAGE);
  check('a mileage finding says how far past its target the car is',
    mileage !== null && /overdue by 1,200 miles — was due at 78,000 miles/.test(mileage.text),
    mileage?.text ?? 'row absent');
  const service = await rowFor(F_SERVICE);
  check('a next-service finding says so', service !== null && /due at the next service/.test(service.text),
    service?.text ?? 'row absent');
  const ownTime = await rowFor(F_OWNTIME);
  check('a description carrying its own timing gets NO second answer',
    ownTime !== null && ownTime.timings === 0,
    ownTime ? `${ownTime.timings} timing element(s): ${ownTime.text}` : 'row absent');
  check('  …and suppression is an ABSENT element, not an empty one',
    ownTime !== null && !/due at|due by|overdue/.test(ownTime.text), ownTime?.text ?? 'row absent');
  check('  …while the other two DO carry one, so the check above can still see a real match',
    mileage?.timings === 1 && service?.timings === 1,
    `${mileage?.timings} / ${service?.timings}`);

  // ── 3. THE READING THE TIMING IS JUDGED AGAINST ──────────────────────────────────────────────
  // Car A's LATEST visit has no odometer. Reading that card's column gives null and the sentence
  // silently loses "overdue by 1,200 miles"; walking back to the visit that did record one keeps it.
  console.log('\n— the newest mileage we hold, not the newest card —');
  const detailA = await page.evaluate(async (v) => {
    const r = await fetch(`/api/marketing-car?vehicleId=${v}`, { credentials: 'same-origin' });
    return r.json();
  }, A);
  check('the latest visit really does have no odometer',
    detailA.history[0].odometerIn === null && detailA.history[1].odometerIn === 79_200,
    JSON.stringify(detailA.history.map((h) => h.odometerIn)));
  check('  …and atMiles is the older visit\'s reading, not null', detailA.atMiles === 79_200,
    String(detailA.atMiles));

  // ── 4. WHAT WAS MEASURED ─────────────────────────────────────────────────────────────────────
  // The strings are the printed-advisory chokepoints', so this asserts the pane quotes the
  // customer's document rather than formatting tenths and millivolts a second time.
  console.log('\n— the caller can quote the measurements —');
  const readings = await textOf('[data-testid="readings"]');
  check('the measurements block renders', readings !== null);
  check('  …four corners of tread', (await page.locator('[data-testid="readings-tyres"] li').count()) === 4);
  check('  …in the document\'s own words, legal limit included',
    /Rear left — 1.5 \/ 1.4 \/ 1.4mm — BELOW LEGAL LIMIT/.test(readings ?? ''));
  check('  …and the alignment spread the same rule already found',
    /Front right — 6.0 \/ 4.5 \/ 2.2mm \(inside edge worn\)/.test(readings ?? ''));
  check('the battery line is the printed one, not a second rendering',
    /Battery — 12.34V, 53% charge, 71% health against 700 CCA EN/.test(readings ?? ''), readings ?? '');
  check('  …with the date it was taken', /Measured 2 Jun 2026/.test(readings ?? ''));

  // ── 5. A CAR NOBODY HAS MEASURED OR READ ─────────────────────────────────────────────────────
  console.log('\n— absent, not zeroed —');
  await gotoCar(Bv, REGS[1]);
  const bText = await textOf('[data-testid="findings-unanswered"]');
  check('with no mileage on record the sentence states the target', /due at 78,000 miles/.test(bText ?? ''), bText ?? '');
  check('  …and claims nothing about having passed it', !/overdue/.test(bText ?? ''), bText ?? '');
  check('no readings means NO block, not an empty one', (await one('[data-testid="readings"]')) === null);
  const detailB = await page.evaluate(async (v) => {
    const r = await fetch(`/api/marketing-car?vehicleId=${v}`, { credentials: 'same-origin' });
    return r.json();
  }, Bv);
  check('  …and atMiles is null, which is what "we have never read one" looks like',
    detailB.atMiles === null, String(detailB.atMiles));

  // ── 6. THE TAP-THROUGH BELOW xl ──────────────────────────────────────────────────────────────
  // Below the breakpoint the other two panes have no Expand control — their headers are hidden — so
  // opening a car MUST move to the history or they are unreachable. Driven by clicking the row a
  // user clicks, at the width a user has.
  console.log('\n— one pane at a time, and a way through —');
  await page.setViewportSize({ width: 1279, height: 900 });
  await page.goto(`${BASE}/admin/marketing?stack=hot`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(500);
  const openLink = page.locator(`[data-testid="open-car-${A}"]`);
  const linkCount = await openLink.count();
  check('the board offers exactly one way into this car', linkCount === 1, `${linkCount} controls`);
  if (linkCount === 1) {
    await openLink.click();
    // WAIT ON THE URL, NOT ON THE PANE. Waiting for `car-history` to appear would make the failure
    // this check exists to catch — the car opening into three panes that xl is hiding, so none of
    // them mounts — arrive as a 30-second timeout and an aborted run. The router settles the query
    // string either way, so waiting on that lets the visibility assertion below fail BY NAME.
    await page.waitForFunction(() => new URL(location.href).searchParams.has('vehicle'), null, { timeout: 15000 });
    await page.waitForTimeout(600);
    check('opening a car below xl lands on the history, not a hidden pane',
      new URL(page.url()).searchParams.get('pane') === 'history'
      && (await visible('[data-testid="pane-history"]'))
      && !(await visible('[data-testid="pane-list"]')),
      page.url());
    const back = await one('[data-testid="pane-back-narrow"]');
    check('  …and Back walks out to the list', back !== null);
    if (back) {
      await back.click();
      await page.waitForTimeout(400);
      check('  …which is the list, with the car still open',
        (await visible('[data-testid="pane-list"]')) && new URL(page.url()).searchParams.get('vehicle') === A,
        page.url());
    }
  }

  // ── 7. THE URL IS THE STATE ──────────────────────────────────────────────────────────────────
  // Not decoration: a caller reloads, and a colleague is sent a link. All three keys must survive a
  // round trip through the address bar and rebuild the same screen.
  console.log('\n— the URL round-trips —');
  const cardId = detailA.history[1].cardId;
  await page.setViewportSize({ width: 1400, height: 900 });
  await gotoCar(A, REGS[0], `&card=${cardId}&pane=detail`);
  check('pane=detail rebuilds the expanded detail pane',
    (await visible('[data-testid="pane-detail"]')) && !(await visible('[data-testid="pane-list"]')));
  const detailText = await textOf('[data-testid="car-detail"]');
  check('  …showing the card the URL named, not the newest',
    /2 Jun 2026/.test(detailText ?? ''), detailText ?? '');
  await gotoCar(A, REGS[0], `&card=${cardId}`);
  check('pane absent at 1400 means all three, not none',
    (await visible('[data-testid="pane-list"]')) && (await visible('[data-testid="pane-history"]'))
    && (await visible('[data-testid="pane-detail"]')));
  const closeBtn = await one('[data-testid="close-car"]');
  check('Close is reachable and clears the car from the URL', closeBtn !== null);
  if (closeBtn) {
    await closeBtn.click();
    await page.waitForTimeout(500);
    const q = new URL(page.url()).searchParams;
    check('  …along with card and pane, so nothing is left behind',
      q.get('vehicle') === null && q.get('card') === null && q.get('pane') === null, page.url());
  }
} catch (e) {
  console.log(`\n✗ THREW: ${String(e?.stack ?? e).slice(0, 1200)}`);
  out.push('F');
} finally {
  if (browser) await browser.close().catch(() => {});
  if (fix) {
    const step = async (n, fn) => { try { await fn(); } catch (e) { console.log(`  teardown ${n}: ${String(e?.message ?? e).slice(0, 120)}`); } };
    await step('tyres', () => prisma.tyreReading.deleteMany({ where: { group_id: ZZ, vehicle_id: { in: fix.vehs } } }));
    await step('battery', () => prisma.batteryReading.deleteMany({ where: { group_id: ZZ, vehicle_id: { in: fix.vehs } } }));
    await step('findings', () => prisma.vehicleDueItem.deleteMany({ where: { group_id: ZZ, vehicle_id: { in: fix.vehs } } }));
    await step('cards', () => prisma.jobCard.deleteMany({ where: { group_id: ZZ, id: { in: fix.cards } } }));
    await step('edges', () => prisma.vehicleOwnership.deleteMany({ where: { vehicle_id: { in: fix.vehs } } }));
    // BY THE FIXTURE'S OWN IDENTIFIERS, never by one the code under test returned.
    await step('vehicles', () => prisma.vehicle.deleteMany({ where: { group_id: ZZ, registration: { in: REGS } } }));
    await step('customer', () => prisma.customer.deleteMany({ where: { group_id: ZZ, id: fix.cust } }));
    const left = await prisma.vehicle.count({ where: { group_id: ZZ, registration: { in: REGS } } })
      + await prisma.customer.count({ where: { group_id: ZZ, id: fix.cust } })
      + await prisma.tyreReading.count({ where: { group_id: ZZ, vehicle_id: { in: fix.vehs } } })
      + await prisma.batteryReading.count({ where: { group_id: ZZ, vehicle_id: { in: fix.vehs } } })
      + await prisma.vehicleDueItem.count({ where: { group_id: ZZ, vehicle_id: { in: fix.vehs } } })
      + await prisma.jobCard.count({ where: { group_id: ZZ, id: { in: fix.cards } } });
    check('teardown removed every fixture row (ZZ only)', left === 0, `${left} left`);
  }
  const f = out.filter((x) => x === 'F').length;
  console.log(`\n${f} failures of ${out.length}`);
  await prisma.$disconnect();
  process.exit(f ? 1 : 0);
}
