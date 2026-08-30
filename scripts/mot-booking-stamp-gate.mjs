// @gate-timeout: 180
/**
 * File: scripts/mot-booking-stamp-gate.mjs
 * WHERE THE BOOKING PATH'S MOT DATA CAME FROM, RECORDED.
 *
 * /api/jobcard writes mot_expiry, last_mot_mileage and last_mot_date when the diary form creates a
 * vehicle, and stamped nothing to say where they came from. mot-refresh is the only writer of
 * mot_checked_at, so 210 of TMBS's 214 stored expiries have no record of ever being verified — and
 * the question "is this date current?" is unanswerable for 98% of the fleet.
 *
 * ── THE HALF THAT MATTERS IS THE ONE THAT DOES NOT STAMP ────────────────────────────────────────
 * The MOT fields arrive as REQUEST BODY PARAMS, already fetched by the browser. The server cannot
 * tell a real DVSA hit from a hand-typed vehicle except by whether they arrived. So the stamp fires
 * only when they did — a vehicle typed in by hand must never carry a mark saying DVSA confirmed it.
 * A false verification is harder to find than a missing one: the missing one is a null anybody can
 * count, and the false one looks exactly like a real check.
 *
 * WHAT THIS BOUNDARY STILL CANNOT SAY: "DVSA answered and the car has no MOT" arrives identically
 * to "no lookup ran" — both are an absent motExpiry. A brand-new car therefore gets no stamp even
 * though it was genuinely checked. Fixing that needs the client to send an explicit "I asked"
 * flag; it is not fixable server-side, and the stamp is deliberately conservative until it is.
 *
 * Fixtures on ZZ Gate Garage only. Never TMBS.
 */
import './_gate-preflight.mjs';
const { zzSite, serverReady, describeError } = await import('./_gate-preflight.mjs');
import './_ts.mjs';
const { PrismaClient } = await import('@prisma/client');
const { chromium } = await import('playwright-core');
const { readFileSync } = await import('node:fs');
const prisma = new PrismaClient();

const ZZ = 'c75ac44e-250a-4c90-98ba-a8326e98dad5';
const WITH = 'ZZ76MSA';
const WITHOUT = 'ZZ76MSB';
const BASE = process.env.GATE_BASE ?? 'http://localhost:3000';
const out = [];
const check = (n, ok, d = '') => { out.push(ok ? 'P' : 'F'); console.log(`${ok ? '✓' : '✗'} ${n}${d ? `  — ${d}` : ''}`); };
let fix = null, browser = null;

try {
  const stale = await prisma.vehicle.count({ where: { group_id: ZZ, registration: { in: [WITH, WITHOUT] } } });
  if (stale) throw new Error(`REFUSING: ${stale} fixture vehicle(s) from a previous run still present`);
  await zzSite(prisma);
  fix = { regs: [WITH, WITHOUT] };

  const ready = await serverReady();
  check('the dev server serves pages before we drive it', ready.ok, `HTTP ${ready.status} after ${ready.attempts} attempt(s)`);
  browser = await chromium.launch({ channel: 'chrome' });
  const page = await (await browser.newContext()).newPage();
  await page.goto(`${BASE}/admin/login`, { waitUntil: 'domcontentloaded' });
  await page.fill('input[type="email"]', 'owner@zzgategarage.test');
  await page.fill('input[type="password"]', 'GateGarage!2026');
  await Promise.all([page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 60000 }), page.click('button[type="submit"]')]);

  const create = (body) => page.evaluate(async (b) => {
    const r = await fetch('/api/jobcard', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin', body: JSON.stringify(b) });
    return { status: r.status, body: await r.json().catch(() => ({})) };
  }, body);

  // ── 1. MOT FIELDS ARRIVED — THEY CAME FROM DVSA, SO SAY SO ───────────────────────────────────
  console.log('\n— a lookup answered —');
  const a = await create({ registration: WITH, customerName: 'MOT Stamp Holder',
    motExpiry: '2027-09-20', lastMotDate: '2026-08-21', lastMotMileage: 117735 });
  check('the card is created', a.status === 200 || a.status === 201, `${a.status} ${JSON.stringify(a.body).slice(0, 80)}`);
  const withV = await prisma.vehicle.findFirst({ where: { group_id: ZZ, registration: WITH },
    select: { mot_expiry: true, last_mot_date: true, last_mot_mileage: true, mot_checked_at: true } });
  check('the MOT facts are stored', withV?.mot_expiry?.toISOString().slice(0, 10) === '2027-09-20'
    && withV?.last_mot_mileage === 117735, JSON.stringify(withV));
  check('AND mot_checked_at IS STAMPED', withV?.mot_checked_at != null,
    'the data came from the same DVSA response the refresh path uses; not saying so is what made 210 expiries unverifiable');

  // ── 2. NOTHING ARRIVED — DO NOT CLAIM A CHECK THAT NEVER HAPPENED ────────────────────────────
  // The discriminating half. Without it the check above passes against a writer that stamps every
  // vehicle it creates, which is the failure mode worth preventing.
  console.log('\n— nothing was looked up —');
  const b = await create({ registration: WITHOUT, customerName: 'MOT Stamp Holder' });
  check('the card is created', b.status === 200 || b.status === 201, String(b.status));
  const woV = await prisma.vehicle.findFirst({ where: { group_id: ZZ, registration: WITHOUT },
    select: { mot_expiry: true, mot_checked_at: true } });
  check('no MOT facts are stored', woV?.mot_expiry === null, JSON.stringify(woV));
  check('AND mot_checked_at IS NOT STAMPED', woV?.mot_checked_at === null,
    'a hand-typed vehicle carrying a verification mark is a false check, and a false check looks exactly like a real one');

  // ── 3. THE EXISTING-VEHICLE PATH IS UNTOUCHED, AND SAYS SO ───────────────────────────────────
  // Reported rather than fixed: the branch that finds an existing vehicle writes nothing to it, so
  // a returning car's MOT is never updated however often the diary looks it up. Pinned here so the
  // next reader knows it is a known gap and not an oversight this gate missed.
  const src = readFileSync('pages/api/jobcard.ts', 'utf8');
  const findAt = src.indexOf('const vehicle = await tx.vehicle.findFirst(');
  const createAt = src.indexOf('const createdVehicle = await tx.vehicle.create(');
  // The emitted KEY, not the word: the first bare `mot_checked_at` in this file is now the comment
  // ABOVE the create explaining the rule, which reported a correct writer as broken on first run.
  const stampAt = src.search(/^\s+mot_checked_at:/m);
  check('the stamp lives in the CREATE branch only', stampAt > createAt && findAt > 0 && findAt < createAt,
    `find ${findAt}, create ${createAt}, stamp ${stampAt} — the existing-vehicle branch still writes nothing`);
} catch (e) {
  console.log(`\n✗ THREW: ${String(e?.stack ?? e).slice(0, 900)}`);
  out.push('F');
} finally {
  if (browser) await browser.close().catch(() => {});
  if (fix) {
    const step = async (n, f) => { try { await f(); } catch (e) { console.log(`  teardown ${n}: ${describeError(e).slice(0, 110)}`); } };
    const vehs = (await prisma.vehicle.findMany({ where: { group_id: ZZ, registration: { in: fix.regs } }, select: { id: true } })).map((v) => v.id);
    await step('cards', () => prisma.jobCard.deleteMany({ where: { group_id: ZZ, vehicle_id: { in: vehs } } }));
    await step('edges', () => prisma.vehicleOwnership.deleteMany({ where: { vehicle_id: { in: vehs } } }));
    await step('vehicles', () => prisma.vehicle.deleteMany({ where: { group_id: ZZ, registration: { in: fix.regs } } }));
    await step('customer', () => prisma.customer.deleteMany({ where: { group_id: ZZ, name: 'MOT Stamp Holder' } }));
    try {
      const left = await prisma.vehicle.count({ where: { group_id: ZZ, registration: { in: fix.regs } } })
        + await prisma.customer.count({ where: { group_id: ZZ, name: 'MOT Stamp Holder' } });
      check('teardown removed every fixture row (ZZ only)', left === 0, `${left} left`);
    } catch (e) {
      check('teardown removed every fixture row (ZZ only)', false, `COULD NOT VERIFY — ${describeError(e).split('\n')[0].slice(0, 70)}`);
    }
  }
  const f = out.filter((x) => x === 'F').length;
  console.log(`\n${f} failures of ${out.length}`);
  await prisma.$disconnect();
  process.exit(f ? 1 : 0);
}
