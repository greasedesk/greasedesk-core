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
 * ── WHAT THIS GATE CANNOT PROVE ─────────────────────────────────────────────────────────────────
 * DVSA is not configured locally (creds live on Vercel). So the endpoint here always takes the
 * no-answer branch — which is fortunate, because that is the branch worth proving on a served
 * page: press Check on a real row and confirm the row does NOT claim to have been checked. The
 * changed/unchanged branches are proven against the pure function, and the write rule they depend
 * on (motFieldsToWrite) is proven in scripts/mot-capture-gate.
 *
 * Fixtures on ZZ Gate Garage only. Never TMBS.
 */
import './_gate-preflight.mjs';
const { explainIfClientStale } = await import('./_gate-preflight.mjs');
import './_ts.mjs';
const { PrismaClient } = await import('@prisma/client');
const { chromium } = await import('/Users/hugh/Developer/greasedesk-core/node_modules/playwright-core/index.mjs');
const { readFileSync } = await import('node:fs');
const R = await import('../lib/mot-refresh.ts');
const M = await import('../lib/marketing-lists.ts');
const prisma = new PrismaClient();

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
  check('and what this gate cannot prove is said out loud',
    /DVSA is not configured locally/.test(prose(readFileSync('scripts/mot-refresh-gate.mjs', 'utf8'))));

  // ── 4. ON THE SERVED PAGE ────────────────────────────────────────────────────────────────────
  const cust = await prisma.customer.create({ data: { group_id: ZZ, name: CUST, phone: '07700900456' }, select: { id: true } });
  const veh = await prisma.vehicle.create({
    data: { group_id: ZZ, registration: REG, registration_normalized: REG, make: 'Fixture', model: 'Refresh',
      year: 2015, mot_expiry: new Date('2026-08-25T00:00:00.000Z') },
    select: { id: true },
  });
  fix = { veh: veh.id, cust: cust.id };
  await prisma.vehicleOwnership.create({ data: { vehicle_id: veh.id, customer_id: cust.id, is_current: true } });

  console.log('\n— pressed on a real row —');
  browser = await chromium.launch({ channel: 'chrome' });
  const page = await (await browser.newContext()).newPage();
  await page.goto(`${BASE}/admin/login`, { waitUntil: 'domcontentloaded' });
  await page.fill('input[type="email"]', 'owner@zzgategarage.test');
  await page.fill('input[type="password"]', 'GateGarage!2026');
  await Promise.all([page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 60000 }), page.click('button[type="submit"]')]);
  await page.goto(`${BASE}/admin/marketing`, { waitUntil: 'domcontentloaded' });
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
    && stamped?.mot_expiry?.toISOString().slice(0, 10) === '2026-08-25', JSON.stringify(stamped));

  // THE ROW DID NOT MOVE. This is the whole of "keep your place in a list you are working".
  check('the row is still there, in the same band, saying what it said',
    await row.count() === 1 && (await row.locator('[data-testid="marketing-due-label"]').textContent()) === before,
    'a reload here would lose the place of whoever is working the list');
  check('  …and nothing is struck through, because nothing changed',
    !(await row.locator('[data-testid="marketing-due-label"]').getAttribute('class') ?? '').includes('line-through'));

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
  check('the Check button is gated to MOT rows', /reason === 'mot' && \(/.test(src),
    'a service date comes from a schedule reading we took ourselves');
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
  check('  …and a fetch that throws still says something',
    (src.match(/didn’t complete/g) ?? []).length === 2,
    'a silent row after a press reads as "no change"');
} catch (e) {
  check('gate run completed', false, String(e?.message ?? e).slice(0, 300));
  await explainIfClientStale(BASE);
} finally {
  if (browser) await browser.close().catch(() => {});
  if (fix) {
    const step = async (n, f) => { try { await f(); } catch (e) { console.log(`  teardown ${n}: ${String(e?.message ?? e).slice(0, 90)}`); } };
    // BY THE FIXTURE'S OWN REGISTRATION, never an id the code handed back.
    const mine = await prisma.vehicle.findMany({ where: { group_id: ZZ, registration: REG }, select: { id: true } });
    const vids = [...new Set([fix.veh, ...mine.map((v) => v.id)])];
    await step('readings', () => prisma.vehicleOdometerReading.deleteMany({ where: { vehicle_id: { in: vids } } }));
    await step('edges', () => prisma.vehicleOwnership.deleteMany({ where: { vehicle_id: { in: vids } } }));
    await step('vehicles', () => prisma.vehicle.deleteMany({ where: { id: { in: vids } } }));
    await step('customers', () => prisma.customer.deleteMany({ where: { group_id: ZZ, name: CUST } }));
    check('teardown removed every fixture row (ZZ only)',
      (await prisma.vehicle.count({ where: { group_id: ZZ, registration: REG } })) === 0
      && (await prisma.customer.count({ where: { group_id: ZZ, name: CUST } })) === 0);
  }
}

console.log(`\n${out.filter((x) => x === 'F').length} failures of ${out.length}`);
await prisma.$disconnect();
process.exit(out.includes('F') ? 1 : 0);
