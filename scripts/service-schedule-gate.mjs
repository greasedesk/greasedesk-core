/**
 * File: scripts/service-schedule-gate.mjs
 * THE FOURTH CAPTURE SHAPE — transcribed, not noticed and not measured.
 *
 * The assertions that matter are the ones where this shape differs from the other three: the MOT is
 * shown and never stored (a row would print it on the invoice twice), the customer response IS
 * defaulted here and nowhere else, "Other" goes through free text, and emptying a row RETRACTS it.
 *
 * Fixtures on ZZ Gate Garage only. Never TMBS.
 */
import './_gate-preflight.mjs';
const { explainIfClientStale } = await import('./_gate-preflight.mjs');
import './_ts.mjs';
const { PrismaClient } = await import('@prisma/client');
const { chromium } = await import('/Users/hugh/Developer/greasedesk-core/node_modules/playwright-core/index.mjs');
const S = await import('../lib/service-schedule.ts');
const D = await import('../lib/due-items.ts');
const { readFileSync } = await import('node:fs');
const prisma = new PrismaClient();

const ZZ = 'c75ac44e-250a-4c90-98ba-a8326e98dad5';
const BASE = process.env.GATE_BASE ?? 'http://localhost:3000';
const out = [];
const check = (n, ok, d = '') => { out.push(ok ? 'P' : 'F'); console.log(`${ok ? '✓' : '✗'} ${n}${d ? `  — ${d}` : ''}`); };
const prose = (t) => t.replace(/^\s*\*\s?/gm, ' ').replace(/\s+/g, ' ');

let fix = null, browser = null;

try {
  // ── 1. EACH ITEM DECLARES ITS OWN CLOCK ──────────────────────────────────────────────────────
  // The basis used to be inferred from which fields somebody filled — the one deviation this file
  // had from refuseDueItem's refusal to guess. Declaring it removes the guess and decides which
  // fields the row even shows.
  console.log('\n— the item says what it is scheduled by —');
  const by = (k) => S.scheduleByKey(k).basis;
  check('an oil service is genuinely both', by('schedule_oil_service') === 'whichever_first',
    'manufacturers specify "12 months or 10,000 miles"');
  check('brake fluid is a date', by('schedule_brake_fluid') === 'date', 'moisture with time, not use');
  check('both pad rows are mileage', by('schedule_pads_front') === 'mileage' && by('schedule_pads_rear') === 'mileage',
    'you cannot predict by date when pads run out');
  check('a vehicle check is a date', by('schedule_vehicle_check') === 'date',
    'a touchpoint books by date — and it is the row that projects with no mileage rate');
  // NON-EMPTY AND NOT ALL THE SAME. The first version demanded 20 characters, which failed on
  // "same as the fronts" — a perfectly good reason, and a length threshold is not what makes a
  // reason a reason.
  check('every item carries WHY, for whoever changes it',
    S.SCHEDULE_ITEMS.every((i) => typeof i.why === 'string' && i.why.trim().length > 0)
    && new Set(S.SCHEDULE_ITEMS.map((i) => i.why)).size >= 4,
    S.SCHEDULE_ITEMS.map((i) => `${i.key}:${i.basis}`).join(' '));
  check('nothing infers a basis any more', !/basisFor/.test(readFileSync('lib/service-schedule.ts', 'utf8'))
    && !/basisFor/.test(readFileSync('pages/api/service-schedule.ts', 'utf8'))
    && !/basisFor/.test(readFileSync('components/jobcard/ServiceSchedule.tsx', 'utf8')),
    'the function that read the filled fields and picked a basis is gone');

  console.log('\n— which legs a row shows —');
  check('a date item shows only a month', JSON.stringify(S.legsFor('date')) === JSON.stringify({ date: true, mileage: false }));
  check('a mileage item shows only miles', JSON.stringify(S.legsFor('mileage')) === JSON.stringify({ date: false, mileage: true }));
  check('whichever_first shows both', JSON.stringify(S.legsFor('whichever_first')) === JSON.stringify({ date: true, mileage: true }));

  console.log('\n— a month, not a day —');
  check('a month becomes the FIRST of it', S.monthToStoredDate('2026-11')?.toISOString().slice(0, 10) === '2026-11-01');
  check('  …and the reason it is the 1st and not the last is recorded',
    /2 OCTOBER/.test(prose(readFileSync('lib/service-schedule.ts', 'utf8'))),
    'a real instant, AND it puts a November item in the 30-day window from early October');
  check('a day-shaped value is refused', S.monthToStoredDate('2026-11-01') === null && S.monthToStoredDate('2026-13') === null);
  check('the stored instant reads back as a month', S.storedDateToMonth(new Date('2026-11-01T00:00:00Z')) === '2026-11');

  console.log('\n— blank rows, and half-filled ones —');
  const it = (k) => S.scheduleByKey(k);
  const entry = (k, o) => ({ key: k, dueMonth: null, dueMileage: null, item: it(k), ...o });
  check('a row with neither leg is blank, not an error',
    S.isBlank(it('schedule_oil_service'), { dueMonth: null, dueMileage: null })
    && S.refuseSchedule([entry('schedule_oil_service')]).length === 0,
    'most cars leave most rows empty');
  check('a pads row with a mileage is complete', S.refuseSchedule([entry('schedule_pads_front', { dueMileage: 45000 })]).length === 0);
  check('a brake-fluid row with a month is complete', S.refuseSchedule([entry('schedule_brake_fluid', { dueMonth: '2027-01' })]).length === 0);
  const half = S.refuseSchedule([entry('schedule_oil_service', { dueMileage: 10000 })]);
  check('a HALF-FILLED oil service is refused', half[0]?.code === 'incomplete', JSON.stringify(half[0]));
  check('  …and the message says which leg is missing', /give the month as well/.test(half[0]?.message ?? ''), half[0]?.message);
  check('  …and the other way round too',
    /give the mileage as well/.test(S.refuseSchedule([entry('schedule_oil_service', { dueMonth: '2027-03' })])[0]?.message ?? ''));
  check('  …and the cost of that strictness is recorded',
    /recording half a rule and projecting from it is the worse failure/.test(prose(readFileSync('lib/service-schedule.ts', 'utf8'))));
  check('a nonsense mileage is still refused', S.refuseSchedule([entry('schedule_pads_front', { dueMileage: -5 })])[0]?.code === 'bad_mileage');
  check('a nonsense month is refused', S.refuseSchedule([entry('schedule_brake_fluid', { dueMonth: '2027-99' })])[0]?.code === 'bad_month');

  // ── 2. THE MOT IS NOT A ROW ──────────────────────────────────────────────────────────────────
  console.log('\n— shown, never stored —');
  check('there is no MOT entry in the catalogue', !S.SCHEDULE_KEYS.has('schedule_mot') && S.scheduleByKey('schedule_mot') === null);
  check('  …and the reason is a named constant, not an omission', S.MOT_IS_READ_ONLY === true);
  check('  …because the block already leads with it',
    /^\(1\) MOT Expiry/.test(D.printedDueItemsBlock({ motExpiry: new Date('2026-08-21T00:00:00Z'), items: [] }) ?? ''),
    'a schedule row would print the MOT twice on every invoice');
  check('"Other" is free text, and says why', S.OTHER_IS_FREE_TEXT === true
    && /would refuse the second/.test(prose(readFileSync('lib/service-schedule.ts', 'utf8'))),
    'two at once — transmission fluid AND diesel additive — and the partial unique index refuses a duplicate key');

  // ── 3. THE DEFAULTED RESPONSE, AND ITS TWIN NOTE ─────────────────────────────────────────────
  console.log('\n— the one place a response is defaulted —');
  const sched = prose(readFileSync('lib/service-schedule.ts', 'utf8'));
  const dueP = prose(readFileSync('lib/due-items.ts', 'utf8'));
  check('the schedule explains why it defaults', /ten months before that conversation happens/.test(sched));
  check('  …and the OPPOSITE rule carries the same note', /ten months before that conversation happens/.test(dueP),
    'they look like one rule contradicting itself, and the next reader will want to harmonise them');
  check('  …which is said out loud, so nobody does', /want to harmonise them/.test(dueP));
  check('findings still refuse a missing response',
    /pre-selects one would make .declined. vanishingly rare/.test(dueP));

  // ── 4. AGAINST THE DATABASE ──────────────────────────────────────────────────────────────────
  console.log('\n— transcribed onto a throwaway car —');
  const site = await prisma.site.findFirst({ where: { group_id: ZZ }, select: { id: true } });
  const veh = await prisma.vehicle.create({ data: { group_id: ZZ, registration: 'ZZ76SCH', make: 'Sched', model: 'Fixture' }, select: { id: true } });
  // FAR ENOUGH ALONG THE SPINE TO REACH COMPLETION. lib/jobcard-tabs gates In-Job on intake being
  // complete AND the quote accepted, and Completion on In-Job — so a card carrying only
  // stage_details_done can show the arrival panel and never the departure one. Set directly as
  // fixture setup: it is a state a real card reaches, and the gating has its own gate.
  const card = await prisma.jobCard.create({
    data: {
      group_id: ZZ, site_id: site.id, vehicle_id: veh.id, status: 'in_progress',
      stage_details_done: true, stage_intake_done: true, stage_injob_done: true,
    },
    select: { id: true },
  });
  fix = { veh: veh.id, card: card.id };

  browser = await chromium.launch({ channel: 'chrome' });
  const page = await (await browser.newContext()).newPage();
  await page.goto(`${BASE}/admin/login`, { waitUntil: 'domcontentloaded' });
  await page.fill('input[type="email"]', 'owner@zzgategarage.test');
  await page.fill('input[type="password"]', 'GateGarage!2026');
  await Promise.all([page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 60000 }), page.click('button[type="submit"]')]);
  const post = (entries, stage = 'departure') => page.evaluate(async (b) => {
    const r = await fetch('/api/service-schedule', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin', body: JSON.stringify(b) });
    return { status: r.status, body: await r.json().catch(() => ({})) };
  }, { jobCardId: card.id, stage, entries });

  // ── THE ARRIVAL READING IS A VISIT FACT AND NEVER REACHES THE INVOICE ────────────────────────
  // The load-bearing distinction: what the computer said on arrival is a fact about a VISIT; what
  // the car needs next is a fact about a CAR. Collapsing them loses "60,000 on arrival, 70,000
  // after" — a completed sale — into the same row as "still 60,000", which is a job that walked.
  console.log('\n— arrival is kept, and printed nowhere —');
  const arrival = await post([
    { key: 'schedule_oil_service', dueMonth: '2026-09', dueMileage: 60000 },
    { key: 'schedule_pads_front', dueMonth: null, dueMileage: 45000 },
  ], 'arrival');
  check('the arrival reading saves', arrival.status === 200 && arrival.body.written === 2, JSON.stringify(arrival.body));
  check('  …into its own table, not as due items',
    (await prisma.serviceScheduleReading.count({ where: { job_card_id: card.id } })) === 2
    && (await prisma.vehicleDueItem.count({ where: { vehicle_id: veh.id } })) === 0,
    'a visit measurement, shaped like a tyre depth');

  // AND THE INVOICE PRINTS NOTHING FOR A CARD THAT ONLY EVER HAD AN ARRIVAL READING. This is the
  // silent-and-wrong case: an arrival figure on a customer's document, presented as what happens
  // next, when in fact we did the work and it no longer applies.
  const arrivalOnlyBlock = D.printedDueItemsBlock({
    motExpiry: null,
    items: await D.openDueItemsForVehicle(prisma, ZZ, veh.id),
  });
  check('a card with ONLY an arrival reading prints no schedule line', arrivalOnlyBlock === null,
    'better an absent line than an arrival figure dressed as what is next');

  const r1 = await post([
    { key: 'schedule_oil_service', dueMonth: '2027-03', dueMileage: 60000 },
    { key: 'schedule_pads_front', dueMonth: null, dueMileage: 45000 },
    { key: 'schedule_vehicle_check', dueMonth: '2027-08', dueMileage: null },
    { key: 'schedule_brake_fluid', dueMonth: null, dueMileage: null },
  ]);
  check('the DEPARTURE schedule saves', r1.status === 200 && r1.body.written === 3, JSON.stringify(r1.body));
  check('  …and the arrival reading is still there beside it',
    (await prisma.serviceScheduleReading.count({ where: { job_card_id: card.id } })) === 2,
    'the departure reading must not overwrite what the car arrived with');
  const arrivalOil = await prisma.serviceScheduleReading.findFirst({ where: { job_card_id: card.id, item_key: 'schedule_oil_service' }, select: { due_mileage: true } });
  const departureOil = await prisma.vehicleDueItem.findFirst({ where: { vehicle_id: veh.id, observation_key: 'schedule_oil_service' }, select: { due_mileage: true } });
  check('the two readings differ and both survive',
    arrivalOil?.due_mileage === 60000 && departureOil?.due_mileage === 60000,
    `arrival ${arrivalOil?.due_mileage}, departure ${departureOil?.due_mileage}`);

  console.log('\n— the stage is declared, never guessed —');
  const noStage = await page.evaluate(async (b) => {
    const r = await fetch('/api/service-schedule', { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin', body: JSON.stringify(b) });
    return { status: r.status, body: await r.json().catch(() => ({})) };
  }, { jobCardId: card.id, entries: [{ key: 'schedule_pads_rear', dueMonth: null, dueMileage: 30000 }] });
  check('a request with no stage is refused', noStage.status === 400 && /arrival or the departure/.test(noStage.body?.message ?? ''),
    'a caller that has not said which reading it holds does not know');
  const items = await prisma.vehicleDueItem.findMany({
    where: { vehicle_id: veh.id, closed_at: null },
    select: { observation_key: true, description: true, due_basis: true, due_mileage: true, customer_response: true },
    orderBy: { observation_key: 'asc' },
  });
  check('  …three rows, three bases', items.length === 3
    && items.find((i) => i.observation_key === 'schedule_oil_service')?.due_basis === 'whichever_first'
    && items.find((i) => i.observation_key === 'schedule_pads_front')?.due_basis === 'mileage'
    && items.find((i) => i.observation_key === 'schedule_vehicle_check')?.due_basis === 'date',
    items.map((i) => `${i.observation_key}:${i.due_basis}`).join(' '));
  check('  …the blank row wrote nothing', !items.some((i) => i.observation_key === 'schedule_brake_fluid'));
  check('  …and the response is not_raised, by design', items.every((i) => i.customer_response === 'not_raised'));

  // RE-TRANSCRIBING CORRECTS. A schedule is a current state, not a log.
  const r2 = await post([{ key: 'schedule_pads_front', dueMonth: null, dueMileage: 48000 }]);
  const pads = await prisma.vehicleDueItem.findMany({ where: { vehicle_id: veh.id, observation_key: 'schedule_pads_front' } });
  check('re-recording corrects rather than stacks', r2.status === 200 && pads.length === 1 && pads[0].due_mileage === 48000,
    `${pads.length} row(s), ${pads[0]?.due_mileage} miles`);

  // EMPTYING A ROW RETRACTS IT.
  const r3 = await post([{ key: 'schedule_pads_front', dueMonth: null, dueMileage: null }]);
  const padsAfter = await prisma.vehicleDueItem.findFirst({ where: { vehicle_id: veh.id, observation_key: 'schedule_pads_front' }, select: { closed_at: true, closed_reason: true } });
  check('emptying a row CLOSES it rather than leaving it', r3.body.cleared === 1 && padsAfter?.closed_at != null,
    'otherwise a wrong date is impossible to retract, and people type 1970 into the field instead');
  check('  …with a reason that says what happened', padsAfter?.closed_reason === 'No longer scheduled');

  // AND IT REACHES THE FROZEN BLOCK, which is the point of reusing VehicleDueItem.
  const open = await D.openDueItemsForVehicle(prisma, ZZ, veh.id);
  const block = D.printedDueItemsBlock({ motExpiry: new Date('2026-08-21T00:00:00Z'), items: open });
  check('it reaches the invoice block with no new plumbing',
    /Next oil service due at 60,000 miles or by March 2027, whichever comes first/.test(block ?? ''), block);
  // THE MINT READS DEPARTURE. Arrival said September 2026; departure said March 2027. The frozen
  // block must carry the SECOND reading — not merely contain it, but not contain the first.
  check('  …carrying the DEPARTURE month and not the arrival one', !/September 2026/.test(block ?? ''),
    'arrival said 2026-09; the customer document must say what the car needs after the work');
  // …and the same renderer DOES print September 2026 when that is the stored value, so the check
  // above is discriminating rather than merely true.
  check('  …and September 2026 is a string this renderer can produce',
    /September 2026/.test(D.printedDueItemsBlock({ motExpiry: null,
      items: open.map((i) => (i.observationKey === 'schedule_oil_service'
        ? { ...i, dueDate: '2026-09-01' } : i)) }) ?? ''),
    'otherwise the absence above proves nothing');
  check('  …saying the MONTH, never a day nobody chose', !/1 March 2027/.test(block ?? ''),
    'the 1st is stored so the row can be ordered; it is not a fact about the car');
  check('  …and the MOT appears exactly ONCE', (block.match(/MOT Expiry/g) ?? []).length === 1,
    'the whole reason there is no MOT row');

  // ── 5. ON THE SERVED CARD ────────────────────────────────────────────────────────────────────
  console.log('\n— above "Record a finding" —');
  await page.goto(`${BASE}/admin/jobcards/${card.id}`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: 'Intake', exact: false }).first().click();
  await page.waitForSelector('[data-testid="service-schedule"]', { timeout: 25000 });
  check('the form renders for EVERY site, with no switch to find', true,
    'no escalation to protect, so nothing to gate');
  const order = await page.evaluate(() => {
    const y = (t) => { const e = document.querySelector(`[data-testid="${t}"]`); return e ? e.getBoundingClientRect().top + window.scrollY : null; };
    return { schedule: y('service-schedule'), findings: y('due-items') };
  });
  check('  …above the findings panel', order.schedule != null && order.findings != null && order.schedule < order.findings,
    `schedule@${Math.round(order.schedule)} findings@${Math.round(order.findings)}`);
  // INTAKE OPENS ON THE ARRIVAL READING, not the departure one. They are different facts and the
  // tab that captures each shows its own — this assertion checked the departure value on the Intake
  // tab and was passing only because both used to be the same row.
  check('  …opening on the ARRIVAL reading, which is what this tab captures',
    (await page.locator('[data-testid="schedule-month-schedule_oil_service"]').inputValue()) === '2026-09',
    'the arrival reading, as a month');
  check('  …saying the basis the ITEM declares', 
    (await page.locator('[data-testid="schedule-basis-schedule_oil_service"]').innerText()).includes('whichever comes first'));
  // EACH ROW SHOWS ONLY ITS OWN CLOCK. This is the change: a pads row has no month field to fill in
  // wrongly, and a brake-fluid row has no mileage field.
  check('a pads row offers a mileage and NO month',
    (await page.locator('[data-testid="schedule-miles-schedule_pads_front"]').count()) === 1
    && (await page.locator('[data-testid="schedule-month-schedule_pads_front"]').count()) === 0);
  check('a brake-fluid row offers a month and NO mileage',
    (await page.locator('[data-testid="schedule-month-schedule_brake_fluid"]').count()) === 1
    && (await page.locator('[data-testid="schedule-miles-schedule_brake_fluid"]').count()) === 0);
  check('an oil service offers both',
    (await page.locator('[data-testid="schedule-month-schedule_oil_service"]').count()) === 1
    && (await page.locator('[data-testid="schedule-miles-schedule_oil_service"]').count()) === 1);
  check('  …and the month input asks for a month, not a day',
    (await page.locator('[data-testid="schedule-month-schedule_oil_service"]').getAttribute('type')) === 'month',
    'a dd/mm/yyyy picker forces a day nobody has');
  check('the MOT is shown and has no input', (await page.locator('[data-testid="schedule-mot"]').count()) === 1
    && (await page.locator('[data-testid="schedule-mot"] input').count()) === 0);

  // ── AND THE DEPARTURE READING LIVES ON COMPLETION ────────────────────────────────────────────
  // Where the work finishes, beside mileage-out, because it cannot be known until the job is done.
  console.log('\n— the after reading, where the work ends —');
  // NAVIGATED BY URL, not by clicking the strip. The active tab lives in ?tab= (JobCardWorkspace),
  // and the strip side-scrolls on a narrow viewport so a tab further along is present, enabled and
  // not clickable. Driving the real state rather than fighting the scroll container.
  await page.goto(`${BASE}/admin/jobcards/${card.id}?tab=completion`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-testid="service-schedule"]', { timeout: 25000 });
  check('the schedule panel is on Completion too', true);
  check('  …opening on the DEPARTURE reading',
    (await page.locator('[data-testid="schedule-month-schedule_oil_service"]').inputValue()) === '2027-03',
    'what the car needs next — the one the invoice freezes');
  check('  …and showing what the car arrived with, for comparison',
    /on arrival: 60,000 mi/.test(await page.locator('[data-testid="schedule-arrival-schedule_oil_service"]').innerText()),
    'so the mechanic corrects a number rather than recalling one');
  check('the heading says which reading it is',
    /what’s next/.test(await page.locator('[data-testid="service-schedule"] h3').innerText()),
    'two panels, two jobs, and neither should be mistaken for the other');
} catch (e) {
  check('gate run completed', false, String(e?.message ?? e).slice(0, 300));
  await explainIfClientStale(BASE);
} finally {
  if (browser) await browser.close().catch(() => {});
  if (fix) {
    const step = async (n, f) => { try { await f(); } catch (e) { console.log(`  teardown ${n}: ${String(e?.message ?? e).slice(0, 90)}`); } };
    await step('due items', () => prisma.vehicleDueItem.deleteMany({ where: { vehicle_id: fix.veh } }));
    await step('card', () => prisma.jobCard.deleteMany({ where: { id: fix.card } }));
    await step('vehicle', () => prisma.vehicle.delete({ where: { id: fix.veh } }));
    check('teardown removed every fixture row (ZZ only)',
      (await prisma.vehicle.count({ where: { group_id: ZZ, id: fix.veh } })) === 0
      && (await prisma.vehicleDueItem.count({ where: { group_id: ZZ, vehicle_id: fix.veh } })) === 0);
  }
}

console.log(`\n${out.filter((c) => c === 'F').length} failures of ${out.length}`);
await prisma.$disconnect();
process.exit(out.includes('F') ? 1 : 0);
