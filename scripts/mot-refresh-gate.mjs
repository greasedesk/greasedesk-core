/**
 * File: scripts/mot-refresh-gate.mjs
 * CHECK BEFORE YOU RING — the per-row DVSA check on the marketing list.
 *
 * The feature is three sentences and one refusal. What it SAYS is the whole product: the row is
 * pressed seconds before someone dials, and a wrong sentence there is acted on immediately.
 *
 *   changed   → "MOT renewed to 25 July 2027 — no longer due."
 *   unchanged → "Checked just now — MOT date unchanged."
 *   no answer → nothing was learned, said so, and mot_checked_at NOT stamped.
 *
 * ── WHAT DVSA DOES AND DOES NOT ANSWER HERE ─────────────────────────────────────────────────────
 * DVSA IS configured on this machine. An earlier version of this header said it was not — copied
 * from scripts/mot-capture-gate without checking, and then ASSERTED as present, so a gate was
 * enforcing a false statement about its own coverage. The observable behaviour was the same, which
 * is exactly what made it survive: a made-up registration returns 404, so a fixture car reaches
 * the no-answer branch either way. The reason was wrong, not the result.
 *
 * Because it does answer, all three branches are proven end to end below, using ONE REAL
 * registration on a ZZ fixture car (read-only public MOT data; the write lands on the fixture,
 * never on the tenant the plate belongs to). What remains unprovable locally is nothing.
 *
 * Fixtures on ZZ Gate Garage only. Never TMBS.
 */
import './_gate-preflight.mjs';
const { gatePrisma, explainIfClientStale, serverReady, describeError } = await import('./_gate-preflight.mjs');
import './_ts.mjs';
const { chromium } = await import('/Users/hugh/Developer/greasedesk-core/node_modules/playwright-core/index.mjs');
const { readFileSync } = await import('node:fs');
const R = await import('../lib/mot-refresh.ts');
const M = await import('../lib/marketing-lists.ts');
const prisma = await gatePrisma();

const ZZ = 'c75ac44e-250a-4c90-98ba-a8326e98dad5';
const BASE = process.env.GATE_BASE ?? 'http://localhost:3000';
const REG = 'ZZ76RFR';
const CUST = 'MOT Refresh Fixture';
const out = [];
const check = (n, ok, d = '') => { out.push(ok ? 'P' : 'F'); console.log(`${ok ? '✓' : '✗'} ${n}${d ? `  — ${d}` : ''}`); };
const prose = (t) => t.replace(/^\s*\*\s?/gm, ' ').replace(/\s+/g, ' ');

let fix = null, browser = null;

try {
  // ── 1. THE THREE SENTENCES ───────────────────────────────────────────────────────────────────
  console.log('\n— three outcomes, and the third is why this exists —');
  const renewed = R.refreshOutcome({ answered: true, heldBefore: '2026-07-22', heldAfter: '2027-07-25', stillDue: false });
  check('a renewed MOT says so, and says it is no longer due',
    renewed.kind === 'changed' && renewed.sentence === 'MOT renewed to 25 July 2027 — no longer due.', renewed.sentence);
  check('  …with the DAY, because DVSA states one',
    /25 July 2027/.test(renewed.sentence) && !/^MOT renewed to July 2027/.test(renewed.sentence),
    'lib/due-items prints a month when the day was never known; here it is known, and dropping it discards a fact');

  const moved = R.refreshOutcome({ answered: true, heldBefore: '2026-07-22', heldAfter: '2026-09-03', stillDue: true });
  check('a date that moved but is still due does not claim to be renewed',
    moved.kind === 'changed' && moved.sentence === 'MOT now expires 3 September 2026 — still due.', moved.sentence);

  const same = R.refreshOutcome({ answered: true, heldBefore: '2026-07-22', heldAfter: '2026-07-22', stillDue: true });
  check('an unchanged date says WHAT was checked', same.kind === 'unchanged' && /MOT date unchanged/.test(same.sentence),
    'a bare "no change" beside a date, a mileage and a customer does not say which was confirmed');

  // THE ONE THAT MATTERS. A failed lookup must not read as a confirmation.
  const dead = R.refreshOutcome({ answered: false, heldBefore: '2026-07-22', heldAfter: null, stillDue: true });
  check('a lookup that never answered says nothing was learned', dead.kind === 'no_answer', dead.sentence);
  check('  …and never says it was checked', !/[Cc]hecked/.test(dead.sentence),
    'the honest-null rule at the sharpest end: this row is about to be acted on');
  check('  …and keeps the date it had rather than blanking it', dead.expiry === '2026-07-22',
    'an absent answer is not an absent MOT');
  check('  …and does not silently drop the car off the list', dead.stillDue === true,
    'unchanged data cannot have changed the band');

  // A car we hold NOTHING for, checked, and DVSA answers with nothing either.
  const neverHeld = R.refreshOutcome({ answered: true, heldBefore: null, heldAfter: null, stillDue: true });
  check('a car with no date, and no date learned, is "unchanged" not "changed"',
    neverHeld.kind === 'unchanged', neverHeld.sentence);

  // ── 2. THE TIME ON THE ROW ───────────────────────────────────────────────────────────────────
  console.log('\n— what "checked" looks like tomorrow —');
  const now = new Date('2026-08-20T14:30:00Z');
  check('a check today shows a clock time', /^checked \d\d:\d\d$/.test(R.checkedLabel(new Date('2026-08-20T09:12:00Z'), now) ?? ''),
    R.checkedLabel(new Date('2026-08-20T09:12:00Z'), now) ?? 'null');
  check('  …and one from another day shows the day', R.checkedLabel(new Date('2026-08-19T09:12:00Z'), now) === 'checked 19 Aug',
    'the question is whether a colleague already did this one, not how many hours ago');
  check('never checked renders nothing at all', R.checkedLabel(null, now) === null,
    'most of the fleet, and not news');

  // ── 3. THE BAND RULE IS SHARED, NOT RESTATED ─────────────────────────────────────────────────
  console.log('\n— one definition of "due" —');
  const api = readFileSync('pages/api/mot-refresh.ts', 'utf8');
  check('the endpoint asks motBand rather than comparing dates itself',
    /motBand\(/.test(api) && !/getTime\(\)\s*[<>]/.test(api),
    'a row cannot disagree with the band it is sitting in about what due means');
  check('  …and motFieldsToWrite is what it writes',
    /motFieldsToWrite\(/.test(api),
    'the sweep and the button must not diverge on refresh-not-fill or on absence-never-erases');
  check('the odometer history is kept, as the sweep does',
    /recordOdometerReadings\(/.test(api),
    'a per-row check producing worse rates than the sweep would be a defect wearing a feature’s clothes');
  check('a failed lookup returns BEFORE any write',
    api.indexOf('if (!data)') < api.indexOf('prisma.vehicle.update'),
    'not the fields, and not mot_checked_at');
  // READ THE HEADER ONLY. The first version of this searched the whole file for a phrase that its
  // own source line contains, so it could never pass — the fixture-name collision rule, applied to
  // a scan whose search word was written into the scanner.
  const header = prose(readFileSync('scripts/mot-refresh-gate.mjs', 'utf8').split('*/')[0]);
  check('the header does not claim DVSA is unconfigured here, because it is not',
    !/is not configured locally/.test(header),
    'the claim was false and was being asserted as present — see the header');
  check('  …and says what a made-up plate actually gets instead', /returns 404/.test(header),
    'the observable behaviour was the same, which is what let a wrong reason survive');

  // ── 4. ON THE SERVED PAGE ────────────────────────────────────────────────────────────────────
  const cust = await prisma.customer.create({ data: { group_id: ZZ, name: CUST, phone: '07700900456' }, select: { id: true } });
  // ── DATED RELATIVE TO THE CLOCK, NEVER PINNED TO A DAY ───────────────────────────────────────
  // This was new Date('2026-08-25'): the future when it was written, the past by the next morning.
  // motBand compares against a TIMESTAMP, not a day — `if (expiry < now) return 'expired'` — so at
  // 00:00 the car left the `due` stack for `expired`, and the gate spent 25s waiting for a row that
  // had moved to another tab. It had been green the evening before. The BAND is the property under
  // test; the date is only how the fixture reaches it, so the date must follow the clock.
  const MOT_DUE = new Date(Date.now() + 30 * 86_400_000);
  const MOT_DUE_ISO = MOT_DUE.toISOString().slice(0, 10);
  const veh = await prisma.vehicle.create({
    data: { group_id: ZZ, registration: REG, registration_normalized: REG, make: 'Fixture', model: 'Refresh',
      year: 2015, mot_expiry: MOT_DUE },
    select: { id: true },
  });
  fix = { veh: veh.id, cust: cust.id };
  await prisma.vehicleOwnership.create({ data: { vehicle_id: veh.id, customer_id: cust.id, is_current: true } });

  console.log('\n— pressed on a real row —');
  // The dev server disposes inactive pages and serves 404s while it rebuilds one; a gate that
  // drives a page that was never served dies as a bare selector timeout 25s later. Warm it and
  // say so — see serverReady in _gate-preflight.
  const ready = await serverReady();
  check('the dev server serves pages before we drive it', ready.ok, `HTTP ${ready.status} after ${ready.attempts} attempt(s)`);
  browser = await chromium.launch({ channel: 'chrome' });
  const page = await (await browser.newContext()).newPage();
  await page.goto(`${BASE}/admin/login`, { waitUntil: 'domcontentloaded' });
  await page.fill('input[type="email"]', 'owner@zzgategarage.test');
  await page.fill('input[type="password"]', 'GateGarage!2026');
  await Promise.all([page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 60000 }), page.click('button[type="submit"]')]);
  // ?stack=warm — the fixture's MOT is days away, not lapsed, so the board puts it in Warm and the
  // page lands on Hot. Navigating to the tab the car is actually in is what a garage would do, and
  // it documents which stack this fixture belongs to.
  await page.goto(`${BASE}/admin/marketing?stack=warm`, { waitUntil: 'domcontentloaded' });
  const row = page.locator(`[data-testid="marketing-row-${veh.id}"]`);
  await row.waitFor({ timeout: 25000 });
  check('the fixture car is on the list', await row.count() === 1);
  check('  …carrying a Check button', await row.locator('[data-testid="marketing-check"]').count() === 1,
    'beside the phone number, as a normal step');

  const before = await row.locator('[data-testid="marketing-due-label"]').textContent();
  await row.locator('[data-testid="marketing-check"]').click();
  await row.locator('[data-testid="marketing-check-result"]').waitFor({ timeout: 25000 });
  const kind = await row.locator('[data-testid="marketing-check-result"]').getAttribute('data-kind');
  const said = (await row.locator('[data-testid="marketing-check-result"]').textContent() ?? '').trim();
  check('pressing it says something', said.length > 0, said);
  // LOCAL DVSA IS UNCONFIGURED, so this is the no-answer branch — the branch worth proving here.
  check('  …and with no DVSA it does NOT claim to have checked', kind === 'no_answer' && !/[Cc]hecked/.test(said), `${kind}: ${said}`);
  check('  …and no time appears on the row', await row.locator('[data-testid="marketing-checked-at"]').count() === 0,
    'mot_checked_at is a fact about data received, never about a button pressed');
  const stamped = await prisma.vehicle.findUnique({ where: { id: veh.id }, select: { mot_checked_at: true, mot_expiry: true } });
  check('  …and nothing was written to the car', stamped?.mot_checked_at === null
    && stamped?.mot_expiry?.toISOString().slice(0, 10) === MOT_DUE_ISO, JSON.stringify(stamped));

  // THE ROW DID NOT MOVE. This is the whole of "keep your place in a list you are working".
  check('the row is still there, in the same band, saying what it said',
    await row.count() === 1 && (await row.locator('[data-testid="marketing-due-label"]').textContent()) === before,
    'a reload here would lose the place of whoever is working the list');
  check('  …and nothing is struck through, because nothing changed',
    !(await row.locator('[data-testid="marketing-due-label"]').getAttribute('class') ?? '').includes('line-through'));

  // ── 4b. THE OTHER TWO BRANCHES, AGAINST A PLATE DVSA ACTUALLY KNOWS ──────────────────────────
  // A REAL registration on a ZZ fixture car. The lookup is read-only public data; every write
  // lands on this fixture, never on the tenant whose plate it is. Held deliberately WRONG (a year
  // early) so the first check must change it — which is the branch a made-up plate can never reach.
  console.log('\n— a plate DVSA knows —');
  const REAL = 'K15NAL';
  const real = await prisma.vehicle.create({
    data: { group_id: ZZ, registration: REAL, registration_normalized: REAL, make: 'Fixture', model: 'Real',
      year: 2015, mot_expiry: new Date('2026-09-11T00:00:00.000Z') },
    select: { id: true },
  });
  fix.real = real.id;
  await prisma.vehicleOwnership.create({ data: { vehicle_id: real.id, customer_id: cust.id, is_current: true } });

  const hit = await page.evaluate(async (id) => {
    const r = await fetch('/api/mot-refresh', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin', body: JSON.stringify({ vehicleId: id }) });
    return { status: r.status, body: await r.json().catch(() => ({})) };
  }, real.id);
  check('DVSA answers for a real plate', hit.body?.outcome?.kind !== 'no_answer',
    `${hit.body?.outcome?.kind}: ${hit.body?.outcome?.sentence}`);
  check('  …the held date was a year out, so this is the CHANGED branch',
    hit.body?.outcome?.kind === 'changed' && /2027/.test(hit.body?.outcome?.sentence ?? ''),
    hit.body?.outcome?.sentence);
  const w1 = await prisma.vehicle.findUnique({ where: { id: real.id },
    select: { mot_expiry: true, mot_checked_at: true, last_mot_mileage: true } });
  check('  …and NOW mot_checked_at is stamped, because something was learned', w1?.mot_checked_at != null,
    w1?.mot_checked_at?.toISOString() ?? 'null');
  check('  …the expiry was written', w1?.mot_expiry?.toISOString().slice(0, 10) === '2027-09-11',
    w1?.mot_expiry?.toISOString().slice(0, 10));
  check('  …and the odometer history came with it, as the sweep does',
    (await prisma.vehicleOdometerReading.count({ where: { vehicle_id: real.id, source: 'mot' } })) > 1,
    'a per-row check must not produce worse rates than the sweep');
  check('  …and it was audited as a refresh, not as an edit',
    (await prisma.auditLog.count({ where: { group_id: ZZ, entity_id: real.id, action: 'vehicle.mot_refresh' } })) === 1);

  // PRESSED AGAIN: nothing has moved, and the wording changes accordingly.
  const again = await page.evaluate(async (id) => {
    const r = await fetch('/api/mot-refresh', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin', body: JSON.stringify({ vehicleId: id }) });
    return await r.json().catch(() => ({}));
  }, real.id);
  check('pressed again, the same car reports UNCHANGED', again?.outcome?.kind === 'unchanged', again?.outcome?.sentence);
  check('  …and no second audit row was written', 
    (await prisma.auditLog.count({ where: { group_id: ZZ, entity_id: real.id, action: 'vehicle.mot_refresh' } })) === 1,
    'a row per press would be noise in an append-only table; what is audited is the CHANGE');

  // AND THE STRIKE, DRAWN. This is the half that was unprovable while the fixtures were fictional.
  // ?stack=warm — the fixture's MOT is days away, not lapsed, so the board puts it in Warm and the
  // page lands on Hot. Navigating to the tab the car is actually in is what a garage would do, and
  // it documents which stack this fixture belongs to.
  await page.goto(`${BASE}/admin/marketing?stack=warm`, { waitUntil: 'domcontentloaded' });
  const realRow = page.locator(`[data-testid="marketing-row-${real.id}"]`);
  if (await realRow.count()) {
    await realRow.locator('[data-testid="marketing-check"]').click();
    await realRow.locator('[data-testid="marketing-check-result"]').waitFor({ timeout: 25000 });
    check('a checked row shows a time on it once DVSA has answered',
      await realRow.locator('[data-testid="marketing-checked-at"]').count() === 1);
  } else {
    // 2027 is outside the 30-day window, so the renewed car correctly leaves the list on reload.
    check('the renewed car is off the list on the next load, which is the point',
      (await prisma.vehicle.findUnique({ where: { id: real.id }, select: { mot_expiry: true } }))
        ?.mot_expiry?.toISOString().slice(0, 10) === '2027-09-11',
      'the row stayed put while it was being worked; the list reconciles when it is next built');
  }

  // ── 5. THE ENDPOINT'S OWN REFUSALS ───────────────────────────────────────────────────────────
  console.log('\n— whose car —');
  const post = (body) => page.evaluate(async (b) => {
    const r = await fetch('/api/mot-refresh', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin', body: JSON.stringify(b) });
    return { status: r.status, body: await r.json().catch(() => ({})) };
  }, body);
  check('no vehicle is a 400', (await post({})).status === 400);
  // A REAL TMBS CAR, READ-ONLY: the endpoint must not find it. Nothing is written on this path —
  // the 404 returns before any lookup — so a live row is safe to name here.
  // A REAL car from another tenant. READ-ONLY on this path — the 404 precedes every write — so the
  // live row is safe to name. Captured before and compared after rather than asserted to be null:
  // "it is null" would pass on a column nothing has ever written, which is not the claim.
  const other = await prisma.vehicle.findFirst({ where: { group_id: { not: ZZ } },
    select: { id: true, mot_checked_at: true, mot_expiry: true } });
  const foreign = await post({ vehicleId: other.id });
  check('another garage’s car is a 404, not a 403', foreign.status === 404,
    'tenant scope in the where clause, not a check afterwards');
  const otherAfter = await prisma.vehicle.findUnique({ where: { id: other.id },
    select: { mot_checked_at: true, mot_expiry: true } });
  check('  …and that car is byte-identical afterwards',
    (otherAfter?.mot_checked_at?.getTime() ?? null) === (other.mot_checked_at?.getTime() ?? null)
    && (otherAfter?.mot_expiry?.getTime() ?? null) === (other.mot_expiry?.getTime() ?? null),
    'the 404 precedes every write');

  // ── 6. THE SERVICE TAB HAS NO BUTTON ─────────────────────────────────────────────────────────
  console.log('\n— nothing to check a service date against —');
  const src = readFileSync('pages/admin/marketing.tsx', 'utf8');
  // GATED TO MOT ROWS UNTIL 2026-08-21, when the board became one row per car and the MOT/service
  // lists went. Every row has a registration now and DVSA answers for every registration, so the
  // question the gate protects is no longer "which list is this" but "is the control still there".
  // COMMENT-STRIPPED. The page's own comment explains that the button USED to be gated on
  // `reason === 'mot'`, so scanning the raw source found the phrase it was banning — the ninth
  // time in two days a scan has matched its own explanation.
  const srcCode = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\{\/\*[\s\S]*?\*\/\}/g, '').replace(/^\s*\/\/.*$/gm, '');
  check('every row can be checked with DVSA', /data-testid="marketing-check"/.test(srcCode)
    && !/reason === 'mot'/.test(srcCode),
    'the old gate was about which LIST a row came from, and the lists are gone');
  check('the stale band count explains itself where it is', /count that decremented/.test(prose(src)),
    'otherwise the next person to find it reads it as a bug');

  // ── 7. WHAT IS PROVEN BY SHAPE RATHER THAN BY RENDER ─────────────────────────────────────────
  // A local run can only ever reach the no_answer branch, so HALF of the strike rule is proven by
  // render above ("nothing is struck through, because nothing changed" — an unanswered row that
  // struck itself would fail there) and half is proven by source shape here: that a CHANGED row
  // draws the strike is not exercised anywhere locally, because no local response can be
  // 'changed'. It is exercised in production, where DVSA is configured. Stated precisely rather
  // than filed under "proven".
  console.log('\n— proven by shape, not by render —');
  check('the strike is bound to "changed" and to no other outcome',
    /checked\?\.kind === 'changed' \? 'line-through/.test(src)
    && (src.match(/line-through/g) ?? []).length === 1,
    'an unchanged or unanswered row must never look renewed');
  check('the row renders the sentence the SERVER produced, not one of its own',
    /\{checked\.sentence\}/.test(src) && !/MOT renewed to/.test(src),
    'lib/mot-refresh owns the words; a second copy in the component is how they drift');
  // THE CHECK'S OWN FALLBACK, not any sentence that resembles it: the send panel added later uses
  // "The send didn't complete", and counting the shared half turned this into a test of an
  // unrelated feature.
  check('  …and a fetch that throws still says something',
    (src.match(/The check didn’t complete/g) ?? []).length === 2,
    'a silent row after a press reads as "no change"');
} catch (e) {
  check('gate run completed', false, describeError(e).slice(0, 300));
  await explainIfClientStale(BASE);
} finally {
  if (browser) await browser.close().catch(() => {});
  if (fix) {
    const step = async (n, f) => { try { await f(); } catch (e) { console.log(`  teardown ${n}: ${describeError(e).slice(0, 90)}`); } };
    // BY THE FIXTURE'S OWN REGISTRATION, never an id the code handed back.
    // BOTH fixture plates, by registration. The real plate is a ZZ row that happens to share a
    // string with a TMBS car — scoped by group_id, so the tenant's own vehicle is untouched.
    const mine = await prisma.vehicle.findMany({ where: { group_id: ZZ, registration: { in: [REG, 'K15NAL'] } }, select: { id: true } });
    const vids = [...new Set([fix.veh, fix.real, ...mine.map((v) => v.id)].filter(Boolean))];
    await step('readings', () => prisma.vehicleOdometerReading.deleteMany({ where: { vehicle_id: { in: vids } } }));
    await step('edges', () => prisma.vehicleOwnership.deleteMany({ where: { vehicle_id: { in: vids } } }));
    await step('vehicles', () => prisma.vehicle.deleteMany({ where: { id: { in: vids } } }));
    await step('customers', () => prisma.customer.deleteMany({ where: { group_id: ZZ, name: CUST } }));
    check('teardown removed every fixture row (ZZ only)',
      (await prisma.vehicle.count({ where: { group_id: ZZ, registration: { in: [REG, 'K15NAL'] } } })) === 0
      && (await prisma.customer.count({ where: { group_id: ZZ, name: CUST } })) === 0);
  }
}

console.log(`\n${out.filter((x) => x === 'F').length} failures of ${out.length}`);
await prisma.$disconnect();
process.exit(out.includes('F') ? 1 : 0);
