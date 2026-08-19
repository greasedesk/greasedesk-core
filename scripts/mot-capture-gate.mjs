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
 * DVSA is not configured locally (creds live on Vercel), so nothing here calls it. The lookup half
 * is proven in production by the 125 TMBS cars that DO carry a date from it. What is proven here is
 * everything downstream of the lookup: the payload, the storage, the convergence, and that both
 * surfaces now ask. Said plainly rather than implied by omission.
 *
 * Fixtures on ZZ Gate Garage only. Never TMBS.
 */
import './_gate-preflight.mjs';
const { explainIfClientStale } = await import('./_gate-preflight.mjs');
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
  const site = await prisma.site.findFirst({ where: { group_id: ZZ }, select: { id: true } });
  fix = { cards: [], vehicles: [], customers: [] };

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
  check('it paces itself', /PACE_MS/.test(sweep), 'this is somebody else’s API');
  check('the reason it was NOT worth running before is recorded',
    /would have been a treadmill/.test(prose(sweep)) && /hide the trend/.test(prose(sweep)));
  check('and what this gate cannot prove is said out loud',
    /DVSA is not configured locally/.test(prose(readFileSync('scripts/mot-capture-gate.mjs', 'utf8'))),
    'the lookup half is proven in production, not here');
} catch (e) {
  check('gate run completed', false, String(e?.message ?? e).slice(0, 300));
  await explainIfClientStale(BASE);
} finally {
  if (browser) await browser.close().catch(() => {});
  if (fix) {
    const step = async (n, f) => { try { await f(); } catch (e) { console.log(`  teardown ${n}: ${String(e?.message ?? e).slice(0, 90)}`); } };
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
