// @gate-timeout: 240
/**
 * File: scripts/completion-carry-gate.mjs
 * WHAT THE COMPLETION PANEL CARRIES FORWARD, AND WHAT IT MUST NOT CLAIM IT WAS HANDED.
 *
 * The departure schedule opened blank while the arrival reading sat one line below it as a hint.
 * A countdown is still true at departure when the work was not done — a service computer chunks in
 * large steps at range, so a test drive does not move the displayed figure — so retyping it was
 * transcription of a number already on the screen.
 *
 * ── THE FIXTURE'S TWO ODOMETERS ARE THE WHOLE DISCRIMINATION ────────────────────────────────────
 * in 100,000 and out 100,150. Every claim below is chosen so that carrying the countdown and
 * RE-DERIVING it give different numbers: 1,240 carried vs 1,090 recomputed, 8,000 derived against
 * arrival vs 7,850 against departure. With one odometer they would be indistinguishable and this
 * gate would pass against the wrong implementation.
 *
 * ── AND THE SEED MUST NOT MAKE THE CLIENT LIE ───────────────────────────────────────────────────
 * `wasRecorded` is how the writer tells "I emptied it" from "I never had it" (classifyEntry). It
 * answers whether the server handed this form a DEPARTURE reading. A carried-forward value is a
 * suggestion, so its key must stay OUT of it — asserted on the REQUEST BODY, because that is where
 * the lie would live, and a database assertion cannot see a claim that had nothing to delete.
 * lib/service-schedule.ts:292 names this exact case as uncovered; this is it arriving.
 *
 * Fixtures on ZZ Gate Garage only. Never TMBS.
 */
import './_gate-preflight.mjs';
const { zzSite, serverReady } = await import('./_gate-preflight.mjs');
import './_ts.mjs';
const { PrismaClient } = await import('@prisma/client');
const { chromium } = await import('playwright-core');
const prisma = new PrismaClient();

const ZZ = 'c75ac44e-250a-4c90-98ba-a8326e98dad5';
const BASE = process.env.GATE_BASE ?? 'http://localhost:3000';
const REG = 'ZZ76CRY';
const REG2 = 'ZZ76CRZ';
const CUST = 'Carry Forward Fixture';
const IN = 100_000, OUT = 100_150;
const out = [];
const check = (n, ok, d = '') => { out.push(ok ? 'P' : 'F'); console.log(`${ok ? '✓' : '✗'} ${n}${d ? `  — ${d}` : ''}`); };
let fix = null, browser = null;

try {
  const stale = await prisma.vehicle.count({ where: { group_id: ZZ, registration: { in: [REG, REG2] } } });
  if (stale) throw new Error(`REFUSING: ${stale} fixture vehicle(s) from a previous run still present`);
  const site = await zzSite(prisma);
  const ready = await serverReady();
  check('the dev server serves pages before we drive it', ready.ok, `HTTP ${ready.status} after ${ready.attempts} attempt(s)`);

  const cust = await prisma.customer.create({ data: { group_id: ZZ, name: CUST, phone: '07700900789' }, select: { id: true } });
  const veh = await prisma.vehicle.create({ data: { group_id: ZZ, registration: REG, registration_normalized: REG, make: 'Carry', model: 'Fixture' }, select: { id: true } });
  const card = await prisma.jobCard.create({
    data: { group_id: ZZ, site_id: site.id, customer_id: cust.id, vehicle_id: veh.id, status: 'in_progress',
      // Completion is GATED behind Details, Intake and In-Job (lib/jobcard-tabs) — the panel does
      // not render until they are done. Fixture setup for a state a real card reaches; the gating
      // has its own gate (service-schedule-gate) and is not re-proven here.
      stage_details_done: true, stage_intake_done: true, stage_injob_done: true,
      odometer_in: IN, odometer_out: OUT },
    select: { id: true },
  });
  // The car with NO arrival rows — claim 8. Its own card, because the seeded one cannot also be empty.
  const veh2 = await prisma.vehicle.create({ data: { group_id: ZZ, registration: REG2, registration_normalized: REG2, make: 'Carry', model: 'Empty' }, select: { id: true } });
  const card2 = await prisma.jobCard.create({
    data: { group_id: ZZ, site_id: site.id, customer_id: cust.id, vehicle_id: veh2.id, status: 'in_progress',
      // Completion is GATED behind Details, Intake and In-Job (lib/jobcard-tabs) — the panel does
      // not render until they are done. Fixture setup for a state a real card reaches; the gating
      // has its own gate (service-schedule-gate) and is not re-proven here.
      stage_details_done: true, stage_intake_done: true, stage_injob_done: true,
      odometer_in: IN, odometer_out: OUT },
    select: { id: true },
  });
  fix = { cust: cust.id, vehs: [veh.id, veh2.id], cards: [card.id, card2.id] };

  await prisma.serviceScheduleReading.createMany({ data: [
    // A COUNTDOWN AS ENTERED. Carried → 1240. Recomputed from its target → 1090. Different on purpose.
    { group_id: ZZ, vehicle_id: veh.id, job_card_id: card.id, item_key: 'schedule_oil_service',
      countdown_miles: 1240, due_mileage: IN + 1240, due_month: new Date('2027-03-01T00:00:00.000Z') },
    // A TARGET ONLY. Against arrival → 8000. Against departure → 7850. Different on purpose.
    { group_id: ZZ, vehicle_id: veh.id, job_card_id: card.id, item_key: 'schedule_pads_front',
      countdown_miles: null, due_mileage: 108_000 },
    // Arrival says 5000 — and a DEPARTURE row exists for this key, which must win.
    // due_mileage as well as the countdown: the table's CHECK (ServiceScheduleReading_has_a_leg)
    // requires a stored leg, and a countdown is not one — it is how the leg was ENTERED.
    { group_id: ZZ, vehicle_id: veh.id, job_card_id: card.id, item_key: 'schedule_pads_rear',
      countdown_miles: 5000, due_mileage: IN + 5000 },
  ] });
  await prisma.vehicleDueItem.create({ data: {
    group_id: ZZ, vehicle_id: veh.id, found_on_job_card_id: card.id, observation_key: 'schedule_pads_rear',
    description: 'Rear brake pads', due_basis: 'mileage', due_mileage: OUT + 3000, customer_response: 'not_raised',
  } });

  browser = await chromium.launch({ channel: 'chrome' });
  const page = await (await browser.newContext()).newPage();
  const posted = [];
  page.on('request', (r) => { if (r.url().includes('/api/service-schedule') && r.method() === 'POST') posted.push(r.postData() ?? ''); });
  await page.goto(`${BASE}/admin/login`, { waitUntil: 'domcontentloaded' });
  await page.fill('input[type="email"]', 'owner@zzgategarage.test');
  await page.fill('input[type="password"]', 'GateGarage!2026');
  await Promise.all([page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 60000 }), page.click('button[type="submit"]')]);

  // ── 1. THE COUNTDOWN IS CARRIED, NOT RECOMPUTED ──────────────────────────────────────────────
  console.log('\n— the departure panel, opened on a car with an arrival reading —');
  await page.goto(`${BASE}/admin/jobcards/${card.id}?tab=completion`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-testid="service-schedule"]', { timeout: 25000 });
  const miles = (k) => page.inputValue(`[data-testid="schedule-miles-${k}"]`);
  const month = (k) => page.inputValue(`[data-testid="schedule-month-${k}"]`);
  const oil = await miles('schedule_oil_service');
  check('the arrival countdown is carried across unchanged', oil === '1240',
    `${oil} — 1090 would mean it was recomputed against the departure odometer, which a test drive moved`);
  check('  …and its date came with it', (await month('schedule_oil_service')) === '2027-03', await month('schedule_oil_service'));

  const front = await miles('schedule_pads_front');
  check('a target-only arrival row derives its countdown against ARRIVAL\'s odometer', front === '8000',
    `${front} — 7850 would be the departure odometer, which is not what that target was read against`);

  // ── 2. A DEPARTURE ROW ALWAYS WINS ───────────────────────────────────────────────────────────
  const rear = await miles('schedule_pads_rear');
  check('a key with a departure row is NOT overwritten by arrival', rear === '3000',
    `${rear} — 5000 is the arrival figure and would mean the seed overwrote a recorded reading`);

  // ── 3. SEEDED ROWS SAY THEY ARE UNCONFIRMED ──────────────────────────────────────────────────
  check('a carried-forward row is marked as such', await page.locator('[data-testid="schedule-carried-schedule_oil_service"]').count() === 1);
  check('  …and a recorded departure row is NOT', await page.locator('[data-testid="schedule-carried-schedule_pads_rear"]').count() === 0,
    'a stored reading is not a suggestion, and marking it one would make every row look unconfirmed');

  // ── 4. THE REQUEST BODY MUST NOT CLAIM THE SEEDED ROWS WERE HANDED OVER ──────────────────────
  posted.length = 0;
  await page.locator('[data-testid="schedule-save"]').click();
  await page.locator('[data-testid="schedule-saved"]').waitFor({ timeout: 25000 });
  const body = JSON.parse(posted[0] ?? '{}');
  const byKey = Object.fromEntries((body.entries ?? []).map((e) => [e.key, e]));
  check('the seeded rows report wasRecorded FALSE on the wire', byKey.schedule_oil_service?.wasRecorded === false
    && byKey.schedule_pads_front?.wasRecorded === false,
    `oil ${byKey.schedule_oil_service?.wasRecorded}, front ${byKey.schedule_pads_front?.wasRecorded} — see lib/service-schedule.ts:292`);
  check('  …while the genuinely recorded one reports TRUE', byKey.schedule_pads_rear?.wasRecorded === true,
    String(byKey.schedule_pads_rear?.wasRecorded));
  check('  …and saving carried the countdowns through to storage',
    (await prisma.vehicleDueItem.findFirst({ where: { vehicle_id: veh.id, observation_key: 'schedule_oil_service', closed_at: null }, select: { due_mileage: true } }))?.due_mileage === OUT + 1240,
    'carried 1240 from a departure reading of 100,150');

  // ── 5. CLEARING A SEEDED ROW DELETES NOTHING ─────────────────────────────────────────────────
  // The end-to-end half of claim 4: a row the form only SUGGESTED cannot be reported as an erasure.
  console.log('\n— a seeded row emptied before it was ever saved —');
  await prisma.vehicleDueItem.deleteMany({ where: { vehicle_id: veh.id, observation_key: 'schedule_pads_front' } });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-testid="service-schedule"]', { timeout: 25000 });
  posted.length = 0;
  await page.fill('[data-testid="schedule-miles-schedule_pads_front"]', '');
  await page.locator('[data-testid="schedule-save"]').click();
  await page.locator('[data-testid="schedule-saved"]').waitFor({ timeout: 25000 });
  const body2 = JSON.parse(posted[0] ?? '{}');
  const front2 = (body2.entries ?? []).find((e) => e.key === 'schedule_pads_front');
  check('emptying a seeded row is not reported as an erasure', front2?.wasRecorded === false,
    `${front2?.wasRecorded} — true here would ask the writer to clear a reading it never gave us`);

  // ── 6. NO ARRIVAL ROWS — SILENT, AND EXACTLY AS BEFORE ───────────────────────────────────────
  console.log('\n— a card whose arrival was never recorded —');
  await page.goto(`${BASE}/admin/jobcards/${card2.id}?tab=completion`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-testid="service-schedule"]', { timeout: 25000 });
  check('nothing is seeded', (await miles('schedule_oil_service')) === '' && (await month('schedule_oil_service')) === '');
  check('  …and nothing is marked carried-forward', await page.locator('[data-testid^="schedule-carried-"]').count() === 0);
  check('  …and no copy explains the absence', !/arrival|came in/i.test(
    await page.locator('[data-testid="service-schedule"]').innerText()),
    'a line on every pre-feature card telling a mechanic something they cannot act on');

  // ── 7. MILEAGE OUT — A TAP, NOT A PREFILL ────────────────────────────────────────────────────
  console.log('\n— mileage out —');
  await prisma.jobCard.update({ where: { id: card2.id }, data: { odometer_out: null } });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-testid="mileage-out-input"]', { timeout: 25000 });
  check('the box is still empty on load', (await page.inputValue('[data-testid="mileage-out-input"]')) === '',
    'a default is indistinguishable from a confirmation');
  const tap = page.locator('[data-testid="mileage-same-as-in"]');
  check('the confirmation is offered', await tap.count() === 1);
  check('  …carrying the actual figure, so it is a statement and not a guess',
    /100,000/.test(await tap.innerText().catch(() => '')), await tap.innerText().catch(() => '(none)'));
  await tap.click();
  await page.waitForTimeout(2500);
  const saved2 = await prisma.jobCard.findUnique({ where: { id: card2.id }, select: { odometer_out: true } });
  check('  …and it writes exactly what typing that number writes', saved2?.odometer_out === IN,
    `${saved2?.odometer_out} — no marker, no second kind of reading`);

  // ABSENT WITH NOTHING TO CONFIRM. A card with no arrival reading has nothing to offer.
  await prisma.jobCard.update({ where: { id: card2.id }, data: { odometer_in: null, odometer_out: null } });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-testid="mileage-out-input"]', { timeout: 25000 });
  check('with no arrival reading there is nothing to confirm, and nothing is offered',
    await page.locator('[data-testid="mileage-same-as-in"]').count() === 0);
} catch (e) {
  console.log(`\n✗ THREW: ${String(e?.stack ?? e).slice(0, 900)}`);
  out.push('F');
} finally {
  if (browser) await browser.close().catch(() => {});
  if (fix) {
    const step = async (n, f) => { try { await f(); } catch (e) { console.log(`  teardown ${n}: ${String(e?.message ?? e).slice(0, 110)}`); } };
    // AuditLog is append-only. Its rows for these cards stay, correctly.
    await step('schedule readings', () => prisma.serviceScheduleReading.deleteMany({ where: { vehicle_id: { in: fix.vehs } } }));
    await step('due items', () => prisma.vehicleDueItem.deleteMany({ where: { vehicle_id: { in: fix.vehs } } }));
    await step('cards', () => prisma.jobCard.deleteMany({ where: { id: { in: fix.cards } } }));
    await step('vehicles', () => prisma.vehicle.deleteMany({ where: { id: { in: fix.vehs } } }));
    await step('customer', () => prisma.customer.deleteMany({ where: { group_id: ZZ, name: CUST } }));
    try {
      const left = (await prisma.vehicle.count({ where: { id: { in: fix.vehs } } }))
        + (await prisma.jobCard.count({ where: { id: { in: fix.cards } } }))
        + (await prisma.customer.count({ where: { group_id: ZZ, name: CUST } }));
      check('teardown removed every fixture row (ZZ only)', left === 0, `${left} left`);
    } catch (e) {
      check('teardown removed every fixture row (ZZ only)', false, `COULD NOT VERIFY — ${String(e?.message ?? e).split('\n')[0].slice(0, 70)}`);
    }
  }
  const f = out.filter((x) => x === 'F').length;
  console.log(`\n${f} failures of ${out.length}`);
  await prisma.$disconnect();
  process.exit(f ? 1 : 0);
}
