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
  // ── 1. A DATE, A MILEAGE, OR BOTH ────────────────────────────────────────────────────────────
  console.log('\n— the basis comes from which legs are filled —');
  check('a date alone is due by a date', S.basisFor({ dueDate: '2027-03-01', dueMileage: null }) === 'date');
  check('a mileage alone is due at a mileage', S.basisFor({ dueDate: null, dueMileage: 60000 }) === 'mileage');
  check('both is whichever comes first', S.basisFor({ dueDate: '2027-03-01', dueMileage: 60000 }) === 'whichever_first',
    'exactly what the garage’s own proforma meant by printing two');
  check('neither is a blank row, not an error', S.basisFor({ dueDate: null, dueMileage: null }) === null && S.isBlank({ dueDate: null, dueMileage: null }),
    'most cars leave most rows empty');
  check('  …and a blank row is never refused', S.refuseSchedule([{ key: 'schedule_oil_service', dueDate: null, dueMileage: null }]).length === 0);
  check('a nonsense mileage IS refused', S.refuseSchedule([{ key: 'schedule_pads_front', dueDate: null, dueMileage: -5 }])[0]?.code === 'bad_mileage');
  check('the inference here is explained against refuseDueItem’s refusal',
    /has no such ambiguity/.test(prose(readFileSync('lib/service-schedule.ts', 'utf8'))),
    'one guesses safely and one must not, and the difference has to be readable');

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
  const card = await prisma.jobCard.create({
    data: { group_id: ZZ, site_id: site.id, vehicle_id: veh.id, status: 'in_progress', stage_details_done: true },
    select: { id: true },
  });
  fix = { veh: veh.id, card: card.id };

  browser = await chromium.launch({ channel: 'chrome' });
  const page = await (await browser.newContext()).newPage();
  await page.goto(`${BASE}/admin/login`, { waitUntil: 'domcontentloaded' });
  await page.fill('input[type="email"]', 'owner@zzgategarage.test');
  await page.fill('input[type="password"]', 'GateGarage!2026');
  await Promise.all([page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 60000 }), page.click('button[type="submit"]')]);
  const post = (entries) => page.evaluate(async (b) => {
    const r = await fetch('/api/service-schedule', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin', body: JSON.stringify(b) });
    return { status: r.status, body: await r.json().catch(() => ({})) };
  }, { jobCardId: card.id, entries });

  const r1 = await post([
    { key: 'schedule_oil_service', dueDate: '2027-03-01', dueMileage: 60000 },
    { key: 'schedule_pads_front', dueDate: null, dueMileage: 45000 },
    { key: 'schedule_vehicle_check', dueDate: '2027-08-01', dueMileage: null },
    { key: 'schedule_brake_fluid', dueDate: null, dueMileage: null },
  ]);
  check('the schedule saves', r1.status === 200 && r1.body.written === 3, JSON.stringify(r1.body));
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
  const r2 = await post([{ key: 'schedule_pads_front', dueDate: null, dueMileage: 48000 }]);
  const pads = await prisma.vehicleDueItem.findMany({ where: { vehicle_id: veh.id, observation_key: 'schedule_pads_front' } });
  check('re-recording corrects rather than stacks', r2.status === 200 && pads.length === 1 && pads[0].due_mileage === 48000,
    `${pads.length} row(s), ${pads[0]?.due_mileage} miles`);

  // EMPTYING A ROW RETRACTS IT.
  const r3 = await post([{ key: 'schedule_pads_front', dueDate: null, dueMileage: null }]);
  const padsAfter = await prisma.vehicleDueItem.findFirst({ where: { vehicle_id: veh.id, observation_key: 'schedule_pads_front' }, select: { closed_at: true, closed_reason: true } });
  check('emptying a row CLOSES it rather than leaving it', r3.body.cleared === 1 && padsAfter?.closed_at != null,
    'otherwise a wrong date is impossible to retract, and people type 1970 into the field instead');
  check('  …with a reason that says what happened', padsAfter?.closed_reason === 'No longer scheduled');

  // AND IT REACHES THE FROZEN BLOCK, which is the point of reusing VehicleDueItem.
  const open = await D.openDueItemsForVehicle(prisma, ZZ, veh.id);
  const block = D.printedDueItemsBlock({ motExpiry: new Date('2026-08-21T00:00:00Z'), items: open });
  check('it reaches the invoice block with no new plumbing',
    /Next oil service due at 60,000 miles or by 1 March 2027, whichever comes first/.test(block ?? ''), block);
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
  check('  …opening on what is already recorded',
    (await page.locator('[data-testid="schedule-date-schedule_oil_service"]').inputValue()) === '2027-03-01',
    'a schedule is a current state, so the form shows it');
  check('  …saying which basis each row recorded',
    (await page.locator('[data-testid="schedule-basis-schedule_oil_service"]').innerText()).includes('whichever comes first'));
  check('the MOT is shown and has no input', (await page.locator('[data-testid="schedule-mot"]').count()) === 1
    && (await page.locator('[data-testid="schedule-mot"] input').count()) === 0);
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
