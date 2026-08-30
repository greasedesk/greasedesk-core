/**
 * File: scripts/mot-capture-gate.mjs
 * THE MOT DATA REACHES THE CAR — from every creating surface, not just the one nobody uses.
 *
 * Two write-path defects, both closed here:
 *   · the diary quick-book never captured motExpiry / lastMotMileage / lastMotDate — a deliberate
 *     scope decision whose measured price was 96 of 221 cars with no MOT date;
 *   · NO creating surface backfilled the DVSA odometer history, because /api/dvsa-lookup keeps it
 *     only when told which vehicle it belongs to and at first lookup there is no vehicle. It
 *     deferred to "the next lookup", which only a manual button performs. Zero MOT-sourced readings
 *     existed for any car, ever.
 *
 * ── WHAT THIS GATE CANNOT PROVE ─────────────────────────────────────────────────────────────────
 * NOTHING HERE CALLS DVSA — not because the credentials are absent (they are present on this
 * machine; that claim sat here for weeks and was wrong), but because these fixtures use made-up
 * registrations, which DVSA answers with a 404. The distinction matters: a gate that says "we
 * cannot reach it" invites nobody to try, and scripts/mot-refresh-gate now proves all three
 * refresh branches locally against one real plate.
 *
 * What is proven here is everything downstream of the lookup: the payload, the storage, the
 * convergence, and that both surfaces now ask. Said plainly rather than implied by omission.
 *
 * Fixtures on ZZ Gate Garage only. Never TMBS.
 */
import './_gate-preflight.mjs';
const { explainIfClientStale, zzSite, serverReady, describeError } = await import('./_gate-preflight.mjs');
import './_ts.mjs';
const { PrismaClient } = await import('@prisma/client');
const { chromium } = await import('/Users/hugh/Developer/greasedesk-core/node_modules/playwright-core/index.mjs');
const O = await import('../lib/odometer.ts');
const { readFileSync } = await import('node:fs');
const prisma = new PrismaClient();

const ZZ = 'c75ac44e-250a-4c90-98ba-a8326e98dad5';
const BASE = process.env.GATE_BASE ?? 'http://localhost:3000';
const out = [];
const check = (n, ok, d = '') => { out.push(ok ? 'P' : 'F'); console.log(`${ok ? '✓' : '✗'} ${n}${d ? `  — ${d}` : ''}`); };
const prose = (t) => t.replace(/^\s*\*\s?/gm, ' ').replace(/\s+/g, ' ');

let fix = null, browser = null;

try {
  // ── 0. THE DATE PARSE — THE REASON 221 CARS HAD NO READINGS ──────────────────────────────────
  // DVSA sends two shapes. `expiryDate` is a bare day (2027-08-02) and `completedDate` is a full
  // ISO timestamp (2026-07-31T09:58:48.000Z). A dot-replacement meant for the LEGACY dotted form
  // (2016.07.31) was applied unconditionally, turning ".000Z" into "-000Z" and making every
  // completedDate unparseable. The history was then filtered away entirely — while motExpiry, which
  // has no dots, kept working. A lookup that looked healthy and dropped seventeen readings per car.
  console.log('\n— two date shapes, and one used to destroy the other —');
  const D = await import('../lib/dvsa.ts');
  const pd = D.__parseMotDateForTest;
  check('an ISO timestamp survives intact', pd('2026-07-31T09:58:48.000Z') === '2026-07-31',
    'this is what completedDate looks like today, and what used to parse as undefined');
  check('a LEGACY dotted date still parses', pd('2016.07.31') === '2016-07-31',
    'the replacement is not dead code — deleting it loses every pre-2018 test');
  check('  …including the dotted form with a time', pd('2016.07.31 09:58:48') === '2016-07-31');
  check('a bare day is untouched', pd('2027-08-02') === '2027-08-02', 'expiryDate — why the fault stayed invisible');
  check('nothing parses to a date', pd('') === undefined && pd(null) === undefined);
  // THE OLD BEHAVIOUR, PROVEN RED HERE rather than described. If a future edit makes the
  // replacement unconditional again, the assertion above fails — and this shows what it would do.
  const unconditional = (v) => { const t = Date.parse(String(v).replace(/\./g, '-')); return Number.isFinite(t) ? new Date(t).toISOString().slice(0, 10) : undefined; };
  check('  …and the unconditional version demonstrably breaks the ISO one',
    unconditional('2026-07-31T09:58:48.000Z') === undefined && unconditional('2016.07.31') === '2016-07-31',
    'both halves: it broke the new shape and it did fix the old one, which is why it was there');
  check('the legacy shape is documented with an example',
    /2016\.07\.31/.test(prose(readFileSync('lib/dvsa.ts', 'utf8'))),
    'the reason for the replacement is otherwise invisible and somebody deletes it');

  // ── 0a. REFRESH, DO NOT MERELY FILL ──────────────────────────────────────────────────────────
  // The first sweep wrote an expiry only into an EMPTY column. It therefore looked up all 221 cars,
  // filled 67 blanks and refreshed nothing — so every MOT date on the marketing page was as old as
  // the last time we happened to see that car. SH64HWW read 22 July 2026, a month in the past,
  // having been looked up that same evening.
  console.log('\n— DVSA is authoritative for a date it issues —');
  const DV = await import('../lib/dvsa.ts');
  const D0 = (iso) => new Date(`${iso}T00:00:00.000Z`);
  const held = { mot_expiry: D0('2026-07-22'), last_mot_mileage: 50000, last_mot_date: D0('2025-07-22') };

  const renewed = DV.motFieldsToWrite(held, { motExpiry: '2027-07-25', lastMotMileage: 58000, lastMotDate: '2026-07-25' });
  check('a NEWER expiry overwrites a stale one',
    renewed.mot_expiry?.toISOString().slice(0, 10) === '2027-07-25', JSON.stringify(renewed.mot_expiry));
  check('  …and so do the two fields the rate depends on',
    renewed.last_mot_mileage === 58000 && renewed.last_mot_date?.toISOString().slice(0, 10) === '2026-07-25',
    'they were stale for exactly the same reason');
  check('an EARLIER expiry also overwrites — that is DVSA correcting us',
    DV.motFieldsToWrite(held, { motExpiry: '2026-03-01' }).mot_expiry?.toISOString().slice(0, 10) === '2026-03-01',
    'we do not hold a better MOT date than the body that issues them');
  check('an unchanged expiry writes nothing',
    Object.keys(DV.motFieldsToWrite(held, { motExpiry: '2026-07-22', lastMotMileage: 50000, lastMotDate: '2025-07-22' })).length === 0,
    'no update, no audit noise, no pointless write');

  console.log('\n— but an absence never erases —');
  check('no response at all leaves everything alone',
    Object.keys(DV.motFieldsToWrite(held, null)).length === 0);
  check('a response with NO expiry leaves the one we hold',
    DV.motFieldsToWrite(held, { make: 'MINI' }).mot_expiry === undefined,
    'far more likely a lookup miss or a car with no test history than an MOT that vanished');
  check('  …and leaves the mileage and date too',
    Object.keys(DV.motFieldsToWrite(held, { make: 'MINI' })).length === 0,
    'honest-null: "we learned nothing" must not become "there is nothing to know"');
  check('a car we hold nothing for still gains what DVSA has',
    DV.motFieldsToWrite({ mot_expiry: null, last_mot_mileage: null, last_mot_date: null }, { motExpiry: '2027-01-09' })
      .mot_expiry?.toISOString().slice(0, 10) === '2027-01-09');
  check('the sweep no longer guards on an empty column',
    !/&& !v\.mot_expiry/.test(readFileSync('scripts/dvsa-backfill.mjs', 'utf8')),
    'that guard is what made a lookup of all 221 cars refresh none of them');
  check('  …and reports gained and corrected separately',
    /MOT dates to FIX/.test(readFileSync('scripts/dvsa-backfill.mjs', 'utf8')),
    '"never had one" and "had a stale one" are different facts about a fleet');

  // ── 0b. AN ENDPOINT THAT ARGUES WITH ITS NEIGHBOUR IS NOT A RATE ─────────────────────────────
  console.log('\n— only the ends set the rate, so only the ends can lie —');
  const O2 = await import('../lib/odometer.ts');
  const d = (iso, miles) => ({ date: new Date(`${iso}T00:00:00.000Z`), miles });
  const clean = [d('2020-01-01', 10000), d('2022-01-01', 30000), d('2024-01-01', 50000)];
  check('a clean history gives a rate', O2.mileageRate(clean).ok);
  // FOUR readings, because with three the middle touches BOTH ends and there is no interior.
  check('a genuinely interior stumble is IGNORED, as it always was',
    O2.mileageRate([d('2019-01-01', 10000), d('2021-01-01', 30000), d('2022-01-01', 20000), d('2024-01-01', 50000)]).ok === true,
    'the middle is never consulted — the rate was always first-to-last');
  // AND THE CONSEQUENCE OF THAT, pinned rather than discovered later: with exactly three readings
  // every backward step is adjacent to an endpoint, so it refuses. That is the conservative answer
  // and the correct one — either the endpoint is wrong (the rate is distorted) or its neighbour is
  // (the rate is fine), and there is nothing in the data that says which.
  check('  …but with only three readings, any stumble touches an end and refuses',
    O2.mileageRate([d('2020-01-01', 10000), d('2022-01-01', 5000), d('2024-01-01', 50000)]).reason === 'endpoints_disagree',
    'no interior exists at length three; refusing is the conservative reading and we cannot tell which value is wrong');
  check('a LAST reading below its neighbour refuses',
    O2.mileageRate([d('2020-01-01', 10000), d('2023-01-01', 50000), d('2024-01-01', 45000)]).reason === 'endpoints_disagree',
    'the rounded-visit-mileage case: 45,000 typed instead of 45,912');
  check('a FIRST reading above its neighbour refuses',
    O2.mileageRate([d('2020-01-01', 20000), d('2021-01-01', 10000), d('2024-01-01', 50000)]).reason === 'endpoints_disagree');
  check('  …and it is a REFUSAL, never a repaired number',
    O2.mileageRate([d('2020-01-01', 10000), d('2023-01-01', 50000), d('2024-01-01', 45000)]).ok === false,
    'a wrong rate is indistinguishable from a right one; a refusal is not');
  check('two readings that go backwards are still goes_backwards',
    O2.mileageRate([d('2020-01-01', 50000), d('2024-01-01', 10000)]).reason === 'goes_backwards',
    'with only two there is no neighbour to disagree with');
  check('no threshold appears anywhere in the rule',
    !/endpoints_disagree[\s\S]{0,400}?[<>]=?\s*\d{3,}/.test(readFileSync('lib/odometer.ts', 'utf8')),
    'any margin would be a constant fitted to eleven cars');
  const od = prose(readFileSync('lib/odometer.ts', 'utf8'));
  check('both rejected repairs are recorded with why they fail',
    /fixes NONE of the three that matter/.test(od) && /replaced instrument cluster/.test(od));
  check('the honest alternative is marked NOT BUILT', /NOT BUILT — THE HONEST ALTERNATIVE/.test(od),
    'surfacing the conflict is a feature with a screen, not a constant');
  // THE RULE, NOT THE WORDING. This matched a literal sentence fragment and broke the moment I
  // reworded "65 of 221" to "65 of TMBS's 221" — an assertion pinned to prose rather than to what
  // the prose has to contain. What the rule requires is a COUNT and a DATE, so that is what it asks
  // for: a data claim that ages visibly, versus a guess wearing a number's clothes.
  check('and the stale backfill claim is corrected in place', /CORRECTED 2026-08-19/.test(od));
  check('  …with the count it replaced the guess with', /65 of [^.]*221 cars/.test(od));
  check('  …and a date on it, so it ages visibly',
    /65 of[\s\S]{0,200}?(19 Aug 2026|2026-08-19)/.test(od),
    'an undated number cannot be told from a guess by whoever finds it next');

  // ── 1. BOTH SURFACES ASK, AND THE REVERSAL IS VISIBLE ────────────────────────────────────────
  console.log('\n— the diary no longer throws it away —');
  const diary = readFileSync('pages/admin/diary.tsx', 'utf8');
  const newPg = readFileSync('pages/admin/jobcards/new.tsx', 'utf8');
  check('the diary sends all three MOT fields',
    /motExpiry: mot\.motExpiry/.test(diary) && /lastMotMileage: mot\.lastMotMileage/.test(diary) && /lastMotDate: mot\.lastMotDate/.test(diary));
  check('  …and keeps them from the lookup that already ran', /if \(r\.mot\) setMot\(r\.mot\)/.test(diary));
  check('the old decision is REWRITTEN, not deleted',
    /REVERSED 2026-08-19/.test(prose(diary)) && /a booking stays off the\s*MOT hot path/.test(prose(diary)),
    'the reversal should be visible with the reasoning it replaced');
  check('  …with the measured price of the old decision',
    /83% → 60% → 47%/.test(prose(diary)) && /never presses it/.test(prose(diary)));

  console.log('\n— and every surface now claims the odometer history —');
  check('the diary backfills after create', /backfillMotHistory\(regCanon, data\?\.vehicleId\)/.test(diary));
  check('the quote entry point does too', /backfillMotHistory\(form\.registration, data\?\.vehicleId\)/.test(newPg),
    'this path always SENT the MOT fields and still never got the readings');
  const client = readFileSync('lib/vehicle-lookup-client.ts', 'utf8');
  check('it is one shared helper, not two copies', (client.match(/export function backfillMotHistory/g) ?? []).length === 1);
  check('  …fire-and-forget, so a booking never waits on it', /void fetch\(/.test(client) && /\.catch\(\(\) => \{\}\)/.test(client));
  check('  …and the deferral it resolves is written down',
    /ZERO MOT-sourced odometer readings, for any vehicle, ever/.test(prose(client)));

  // ── 2. THE PAYLOAD LANDS ─────────────────────────────────────────────────────────────────────
  console.log('\n— on a real create, through the real endpoint —');
  const site = await zzSite(prisma);
  fix = { cards: [], vehicles: [], customers: [] };

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

  const created = await page.evaluate(async (b) => {
    const r = await fetch('/api/jobcard', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin', body: JSON.stringify(b) });
    return { status: r.status, body: await r.json().catch(() => ({})) };
  }, {
    registration: 'ZZ76MOT', customerName: 'MOT Capture Fixture', siteId: site.id,
    make: 'Mot', model: 'Fixture', motExpiry: '2027-03-14', lastMotMileage: 61234, lastMotDate: '2026-03-14',
  });
  check('the card is created', created.status === 201, `HTTP ${created.status}: ${created.body?.message ?? ''}`);
  if (created.body?.id) fix.cards.push(created.body.id);
  if (created.body?.vehicleId) fix.vehicles.push(created.body.vehicleId);

  check('the response carries the vehicleId', typeof created.body?.vehicleId === 'string',
    'without it the caller cannot backfill a car that did not exist at lookup time');
  const veh = created.body?.vehicleId
    ? await prisma.vehicle.findUnique({ where: { id: created.body.vehicleId }, select: { mot_expiry: true, last_mot_mileage: true, last_mot_date: true } })
    : null;
  check('the MOT expiry landed', veh?.mot_expiry?.toISOString().slice(0, 10) === '2027-03-14', String(veh?.mot_expiry));
  check('  …and the last MOT mileage, which feeds the rate', veh?.last_mot_mileage === 61234,
    'the field the diary was dropping alongside the date');
  check('  …and the last MOT date', veh?.last_mot_date?.toISOString().slice(0, 10) === '2026-03-14');

  // ── 3. THE HISTORY CONVERGES ─────────────────────────────────────────────────────────────────
  // What a backfill actually does with what DVSA returns. Nine readings is a typical MOT history.
  console.log('\n— nine readings, stored twice, still nine —');
  const vid = created.body.vehicleId;
  const history = Array.from({ length: 9 }, (_, i) => ({ date: `${2017 + i}-05-0${(i % 8) + 1}`, miles: 20000 + i * 6000 }));
  const first = await O.recordOdometerReadings(prisma, { groupId: ZZ, vehicleId: vid, source: 'mot', readings: history });
  const again = await O.recordOdometerReadings(prisma, { groupId: ZZ, vehicleId: vid, source: 'mot', readings: history });
  const rows = await prisma.vehicleOdometerReading.count({ where: { vehicle_id: vid, source: 'mot' } });
  check('nine readings stored', first === 9 && rows === 9, `${first} written, ${rows} rows`);
  check('  …and a re-run converges rather than accumulating', again === 9 && rows === 9,
    'which is what makes a sweep safe to re-run after a partial failure');

  const readings = await O.readingsForVehicle(prisma, ZZ, vid);
  const rate = O.mileageRate(readings);
  check('and THAT is what makes a rate possible', rate.ok === true, JSON.stringify(rate.ok ? { milesPerYear: rate.milesPerYear, spanDays: rate.spanDays } : rate));
  check('  …which one visit-mileage alone never could',
    O.mileageRate(readings.slice(0, 1)).reason === 'too_few',
    '30 of 221 real cars have the two readings a rate needs; this is why');

  // ── 4. THE SWEEP REFUSES BEFORE IT SPENDS SOMEBODY ELSE'S QUOTA ──────────────────────────────
  console.log('\n— the catch-up, and what it will not do by accident —');
  const sweep = readFileSync('scripts/dvsa-backfill.mjs', 'utf8');
  check('it is a DRY RUN unless told otherwise', /const WRITE = args\.includes\('--write'\)/.test(sweep));
  check('  …and refuses to run across every tenant', /--group=<id> is required/.test(sweep),
    'a sweep across all tenants is a quota question nobody has answered');
  check('  …and refuses when DVSA is not configured', /dvsaConfigured\(\)/.test(sweep));
  // A CALL, not a mention: /PACE_MS/ was true of an `import { PACE_MS }` line whether or not the
  // sweep ever waited. Found by the scan-shape check in gate-hygiene-gate.
  check('it paces itself', /await\s+\w*sleep\w*\(\s*PACE_MS|setTimeout\([^)]*PACE_MS/i.test(sweep),
    'this is somebody else’s API');
  check('the reason it was NOT worth running before is recorded',
    /would have been a treadmill/.test(prose(sweep)) && /hide the trend/.test(prose(sweep)));
  check('and what this gate cannot prove is said out loud',
    /NOTHING HERE CALLS DVSA/.test(prose(readFileSync('scripts/mot-capture-gate.mjs', 'utf8'))),
    'and says WHY — made-up registrations, not missing credentials');
} catch (e) {
  check('gate run completed', false, describeError(e).slice(0, 300));
  await explainIfClientStale(BASE);
} finally {
  if (browser) await browser.close().catch(() => {});
  if (fix) {
    const step = async (n, f) => { try { await f(); } catch (e) { console.log(`  teardown ${n}: ${describeError(e).slice(0, 90)}`); } };
    // TORN DOWN BY REGISTRATION, not by the id the API handed back. A probe that stops the endpoint
    // returning vehicleId leaves fix.vehicles empty — and the first version then deleted nothing and
    // reported success on the row it had failed to find. The fixture's own identifier is the one
    // thing a probe cannot take away.
    const mine = await prisma.vehicle.findMany({ where: { group_id: ZZ, registration: 'ZZ76MOT' }, select: { id: true } });
    const vids = [...new Set([...fix.vehicles, ...mine.map((v) => v.id)])];
    await step('readings', () => prisma.vehicleOdometerReading.deleteMany({ where: { vehicle_id: { in: vids } } }));
    await step('cards', () => prisma.jobCard.deleteMany({ where: { OR: [{ id: { in: fix.cards } }, { vehicle_id: { in: vids } }] } }));
    await step('edges', () => prisma.vehicleOwnership.deleteMany({ where: { vehicle_id: { in: vids } } }));
    await step('vehicles', () => prisma.vehicle.deleteMany({ where: { id: { in: vids } } }));
    await step('customers', () => prisma.customer.deleteMany({ where: { group_id: ZZ, name: 'MOT Capture Fixture' } }));
    check('teardown removed every fixture row (ZZ only)',
      (await prisma.vehicle.count({ where: { group_id: ZZ, registration: 'ZZ76MOT' } })) === 0
      && (await prisma.customer.count({ where: { group_id: ZZ, name: 'MOT Capture Fixture' } })) === 0);
  }
}

console.log(`\n${out.filter((x) => x === 'F').length} failures of ${out.length}`);
await prisma.$disconnect();
process.exit(out.includes('F') ? 1 : 0);
