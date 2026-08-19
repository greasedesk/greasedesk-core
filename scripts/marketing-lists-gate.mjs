/**
 * File: scripts/marketing-lists-gate.mjs
 * WHICH CARS ARE DUE, WHAT IT IS WORTH, AND WHO TO RING — and the four ways this goes wrong.
 *
 * A badge that never falls. A list that hides the cars most worth ringing. A revenue figure read as
 * a forecast. And a customer silenced on a channel they never refused.
 *
 * Fixtures on ZZ Gate Garage only. Never TMBS.
 */
import './_gate-preflight.mjs';
const { explainIfClientStale } = await import('./_gate-preflight.mjs');
import './_ts.mjs';
const { PrismaClient } = await import('@prisma/client');
const { chromium } = await import('/Users/hugh/Developer/greasedesk-core/node_modules/playwright-core/index.mjs');
const M = await import('../lib/marketing-lists.ts');
const { readFileSync } = await import('node:fs');
const prisma = new PrismaClient();

const ZZ = 'c75ac44e-250a-4c90-98ba-a8326e98dad5';
const BASE = process.env.GATE_BASE ?? 'http://localhost:3000';
const out = [];
const check = (n, ok, d = '') => { out.push(ok ? 'P' : 'F'); console.log(`${ok ? '✓' : '✗'} ${n}${d ? `  — ${d}` : ''}`); };
const prose = (t) => t.replace(/^\s*\*\s?/gm, ' ').replace(/\s+/g, ' ');
const NOW = new Date('2026-08-19T12:00:00Z');
const day = (n) => new Date(NOW.getTime() + n * 86_400_000);

let fix = null, browser = null;

try {
  // ── 1. THE MOT BANDS ─────────────────────────────────────────────────────────────────────────
  console.log('\n— expired is its own band, not "very due" —');
  check('a lapsed MOT is expired', M.motBand(day(-5), NOW) === 'expired');
  check('one due next week is due', M.motBand(day(7), NOW) === 'due');
  check('one due in three months is neither', M.motBand(day(90), NOW) === null);
  check('no date at all is neither', M.motBand(null, NOW) === null,
    'and is counted separately, because a list that silently omits cars misrepresents itself');

  // ── 2. THE SERVICING BANDS ───────────────────────────────────────────────────────────────────
  console.log('\n— the trigger band is not a failure bin —');
  const item = (o) => ({ id: o.id ?? 'x', description: o.description ?? 'Thing', dueBasis: o.dueBasis, dueDate: o.dueDate ?? null, dueMileage: o.dueMileage ?? null, customerResponse: 'not_raised', foundOnJobCardId: null, createdAt: '2026-01-01' });
  const noRate = { now: NOW, currentMiles: 50000, readings: [] };
  const withRate = { now: NOW, currentMiles: 50000, readings: [
    { date: new Date('2025-08-01'), miles: 38000 }, { date: new Date('2026-08-01'), miles: 50000 },
  ] };

  const dated = M.serviceDue([item({ dueBasis: 'date', dueDate: '2026-09-01' })], noRate);
  check('a date lands in the dated band', dated[0]?.band === 'dated');
  const nextSvc = M.serviceDue([item({ dueBasis: 'next_service' })], noRate);
  check('next_service lands in the TRIGGER band, not nowhere', nextSvc[0]?.band === 'trigger',
    'a car due at its next service is overdue a visit by definition — hiding it removes the best call');
  const mileageNoRate = M.serviceDue([item({ dueBasis: 'mileage', dueMileage: 90000 })], noRate);
  check('a mileage with no rate is a trigger, not a fake date', mileageNoRate[0]?.band === 'trigger' && mileageNoRate[0]?.date === null,
    'a projected reminder built on an invented rate looks like a decision somebody made');
  const wf = M.serviceDue([item({ dueBasis: 'whichever_first', dueDate: '2026-09-01', dueMileage: 90000 })], noRate);
  check('whichever_first with no rate shows on its DATE leg, flagged',
    wf[0]?.band === 'dated' && wf[0]?.mileageLegUnevaluated === true, JSON.stringify(wf[0]?.date));
  const overdueMiles = M.serviceDue([item({ dueBasis: 'mileage', dueMileage: 45000 })], withRate);
  check('a car PAST its mileage target is overdue, not unprojectable',
    overdueMiles[0]?.band === 'dated' && overdueMiles[0]?.date?.getTime() === NOW.getTime(),
    'projectMileageDate returns null past the target and effectiveDueDate calls that "no_rate"');
  // THE WORKAROUND IS GONE, because the chokepoint answers the question now. This file used to
  // detect a passed target itself and carry a comment explaining why it could not be fixed at the
  // source — a justification that turned out to be false (effectiveDueDate had one caller: this
  // one). Asserting the ABSENCE, so the workaround cannot quietly return alongside the fix.
  const mlSrc = readFileSync('lib/marketing-lists.ts', 'utf8');
  check('  …answered by the chokepoint, not worked around here',
    !/currentMiles >= item\.dueMileage/.test(mlSrc) && /alreadyPassed/.test(mlSrc),
    'one function, one answer — a caller should not translate a failure code into a fact');

  // ── 3. THE BADGE ─────────────────────────────────────────────────────────────────────────────
  console.log('\n— a count that never falls is one nobody sees —');
  check('nobody has done anything → unactioned', M.isUnactioned({ dueDate: day(10) }, null, NOW));
  check('contacted about THIS trigger → actioned',
    !M.isUnactioned({ dueDate: day(10) }, { reason: 'mot', forDate: day(10), snoozeUntil: null, createdAt: NOW }, NOW));
  check('snoozed → actioned until it lapses',
    !M.isUnactioned({ dueDate: day(10) }, { reason: 'mot', forDate: day(10), snoozeUntil: day(5), createdAt: NOW }, NOW));
  check('  …and unactioned again once it does',
    M.isUnactioned({ dueDate: day(10) }, { reason: 'mot', forDate: day(10), snoozeUntil: day(-1), createdAt: NOW }, NOW));
  check('a contact is SPENT once its own date passes',
    M.isUnactioned({ dueDate: day(-2) }, { reason: 'mot', forDate: day(-2), snoozeUntil: null, createdAt: day(-3) }, NOW),
    'contacted about an MOT due Monday, still not done Tuesday — ring them again');
  check('  …which is also what catches a "booked" that never happened',
    M.isUnactioned({ dueDate: day(-1) }, { reason: 'mot', forDate: day(-1), snoozeUntil: null, createdAt: day(-2) }, NOW),
    'booked trusts the tap, and this is the self-correction that limits the cost');
  check('a renewed MOT is a NEW cycle',
    M.isUnactioned({ dueDate: day(300) }, { reason: 'mot', forDate: day(10), snoozeUntil: null, createdAt: NOW }, NOW),
    'the trigger moved a year out, so last year’s call does not cover it');
  // THE CASE THE GATE CAUGHT. An expired MOT's trigger is already past, so spending at the trigger
  // alone meant the record died the moment it was written and the badge never moved.
  check('contacting about an ALREADY-EXPIRED trigger still counts as actioned',
    !M.isUnactioned({ dueDate: day(-6) }, { reason: 'mot', forDate: day(-6), snoozeUntil: null, createdAt: NOW }, NOW),
    'otherwise the Expired band — the best calls on the page — can never be cleared');
  check('  …and comes back a month later', M.isUnactioned(
    { dueDate: day(-6) }, { reason: 'mot', forDate: day(-6), snoozeUntil: null, createdAt: day(-40) }, NOW));
  check('the badge rule cites the Messages lesson', /noise pretending to be information/.test(prose(readFileSync('lib/marketing-lists.ts', 'utf8'))));

  // ── 4. WHO CAN BE CONTACTED ──────────────────────────────────────────────────────────────────
  console.log('\n— an opt-out is an opt-out of everything, but only on its own channel —');
  const c = (o) => ({ sms_opt_out: null, email_opt_out: null, phone: '01384 000000', phone_e164: '+441384000000', email: 'a@b.test', ...o });
  check('no preference recorded means reachable', M.contactRoute(c({})).sms && M.contactRoute(c({})).email,
    'honest-null: we refuse on a recorded true, not on an absence');
  check('refusing texts leaves email alone',
    !M.contactRoute(c({ sms_opt_out: true })).sms && M.contactRoute(c({ sms_opt_out: true })).email,
    'collapsing the channels would take a decision the customer never made');
  check('the phone number survives BOTH refusals',
    M.contactRoute(c({ sms_opt_out: true, email_opt_out: true })).phone === '01384 000000',
    'a phone call is not an electronic message');
  check('the label says which is refused',
    M.noContactLabel({ sms_opt_out: true, email_opt_out: null }) === 'No texts'
    && M.noContactLabel({ sms_opt_out: null, email_opt_out: true }) === 'No email'
    && M.noContactLabel({ sms_opt_out: true, email_opt_out: true }) === 'No electronic contact'
    && M.noContactLabel({ sms_opt_out: null, email_opt_out: null }) === null);
  const ml = prose(readFileSync('lib/marketing-lists.ts', 'utf8'));
  check('the COST of the rule is recorded, not just the rule',
    /will not be emailed when their MOT expires/.test(ml) && /price of not adjudicating/.test(ml),
    'a known consequence rather than an oversight');
  check('  …and so is the refusal to adjudicate', /no adjudicating which is which/.test(ml));

  // ── 5. THE TILE ──────────────────────────────────────────────────────────────────────────────
  console.log('\n— a rule of thumb, labelled as one —');
  const rev = M.estimateRevenue(23, 17_800);
  check('count × average', rev.ok && rev.pennies === 23 * 17_800 && rev.cars === 23);
  check('no history means NO NUMBER', M.estimateRevenue(23, null).ok === false);
  check('  …and no invented average', M.estimateRevenue(23, 0).ok === false);
  check('the MOT tab refuses an average-job figure', M.estimateMotRevenue(11, null).ok === false,
    'an MOT is a fixed-price product; £178 × 11 would overstate it threefold');
  check('  …and takes a real MOT price when there is one', M.estimateMotRevenue(11, 5_400).pennies === 59_400);
  check('the reason the MOT tab differs is written down', /overstate this list threefold/.test(prose(readFileSync('lib/marketing-data.ts', 'utf8'))));

  // ── 6. ON THE SERVED PAGE ────────────────────────────────────────────────────────────────────
  console.log('\n— and on the page a garage opens —');
  // ── THE TEARDOWN HANDLE IS ASSIGNED BEFORE ANYTHING DEPENDS ON IT ──────────────────────────
  // The first version set `fix` after the whole group of creates. A wrong column on the ownership
  // edge threw halfway through, `fix` was still null, the finally block did nothing, and two
  // vehicles and a customer were left on ZZ. Register each row the moment it exists.
  fix = { vehicles: [], customer: null };
  const site = await prisma.site.findFirst({ where: { group_id: ZZ }, select: { id: true } });
  const expired = await prisma.vehicle.create({ data: { group_id: ZZ, registration: 'ZZ76MK1', make: 'Mkt', model: 'Expired', mot_expiry: day(-6) }, select: { id: true } });
  fix.vehicles.push(expired.id);
  const soon = await prisma.vehicle.create({ data: { group_id: ZZ, registration: 'ZZ76MK2', make: 'Mkt', model: 'Soon', mot_expiry: day(9) }, select: { id: true } });
  fix.vehicles.push(soon.id);
  const cust = await prisma.customer.create({ data: { group_id: ZZ, site_id: site.id, name: 'Marketing Fixture', phone: '01384 111222', phone_e164: '+441384111222', email: 'mk@example.invalid', sms_opt_out: true }, select: { id: true } });
  fix.customer = cust.id;
  // VehicleOwnership carries no group_id — the tenant comes through the vehicle.
  for (const v of [expired.id, soon.id]) {
    await prisma.vehicleOwnership.create({ data: { vehicle_id: v, customer_id: cust.id, is_current: true } });
  }

  browser = await chromium.launch({ channel: 'chrome' });
  const page = await (await browser.newContext()).newPage();
  await page.goto(`${BASE}/admin/login`, { waitUntil: 'domcontentloaded' });
  await page.fill('input[type="email"]', 'owner@zzgategarage.test');
  await page.fill('input[type="password"]', 'GateGarage!2026');
  await Promise.all([page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 60000 }), page.click('button[type="submit"]')]);
  await page.goto(`${BASE}/admin/marketing`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-testid="marketing-tab-mot"]', { timeout: 25000 });

  check('the expired car is on the page', (await page.locator(`[data-testid="marketing-row-${expired.id}"]`).count()) === 1);
  check('  …in the Expired band, above Due soon', (await page.evaluate(() => {
    const y = (t) => { const e = document.querySelector(`[data-testid="${t}"]`); return e ? e.getBoundingClientRect().top + window.scrollY : null; };
    const a = y('marketing-band-expired'), b = y('marketing-band-due-soon');
    return a != null && b != null && a < b;
  })), 'a lapsed MOT is a better call than one three weeks away');
  const rowText = await page.locator(`[data-testid="marketing-row-${expired.id}"]`).innerText();
  check('the opted-out customer still appears', /Marketing Fixture/.test(rowText));
  check('  …marked "No texts", not silenced entirely', /No texts/.test(rowText), rowText.replace(/\n/g, ' | '));
  check('  …with the phone number shown', /01384 111222/.test(rowText), 'no opt-out covers a phone call');
  // THREE NUMBERS, because one overstated the gap. Asserted against the DATABASE rather than
  // against the sentence, so the line cannot drift from what is actually true of the fleet.
  const coverage = await page.locator('[data-testid="marketing-no-mot-date"]').innerText();
  const undated = await prisma.vehicle.findMany({ where: { group_id: ZZ, mot_expiry: null }, select: { year: true } });
  const firstMotYear = NOW.getUTCFullYear() - M.MOT_EXEMPT_YEARS;
  const gaps = undated.filter((v) => v.year != null && v.year < firstMotYear).length;
  const unknown = undated.filter((v) => v.year == null).length;
  check('the coverage line states the GAP, not every undated car',
    gaps === 0 ? !/have no MOT date from DVSA/.test(coverage) : coverage.includes(`${gaps} of your`),
    `${coverage} — expected gap ${gaps}`);
  check('  …and says separately how many it cannot judge',
    unknown === 0 ? !/no year recorded/.test(coverage) : coverage.includes(`${unknown} car`), coverage);
  check('  …with nothing said when there is nothing to say',
    (gaps > 0 || unknown > 0) === (await page.locator('[data-testid="marketing-no-mot-date"]').count() === 1),
    'a line reading "0 of your cars" is the badge mistake in sentence form');
  check('  …because a car too new to need an MOT is not a gap',
    /too new to need one/.test(coverage) || undated.every((v) => v.year == null || v.year < firstMotYear),
    'counting those would overstate the gap on a screen a garage is asked to trust');

  const tile = await page.locator('[data-testid="marketing-revenue"]').innerText();
  check('the MOT tab shows no invented figure', /add an MOT to your products/.test(tile), tile.replace(/\n/g, ' | '));

  // THE BADGE FALLS WHEN THE LIST IS WORKED. The whole point.
  const before = await (await page.request.get(`${BASE}/api/marketing/unactioned`)).json();
  await page.locator(`[data-testid="marketing-row-${expired.id}"] [data-testid="marketing-contacted"]`).click();
  await page.waitForTimeout(2500);
  const after = await (await page.request.get(`${BASE}/api/marketing/unactioned`)).json();
  check('recording a contact makes the badge FALL', after.unactioned === before.unactioned - 1,
    `${before.unactioned} → ${after.unactioned}`);
  const rec = await prisma.marketingContact.findFirst({ where: { vehicle_id: expired.id }, select: { state: true, for_date: true, snooze_until: true } });
  check('  …recorded against the car, with the trigger it was about', rec?.state === 'contacted' && rec?.for_date != null);
  check('  …and no snooze on a non-snooze state', rec?.snooze_until === null,
    'the CHECK constraint refuses the other direction too');
} catch (e) {
  check('gate run completed', false, String(e?.message ?? e).slice(0, 300));
  await explainIfClientStale(BASE);
} finally {
  if (browser) await browser.close().catch(() => {});
  if (fix) {
    const step = async (n, f) => { try { await f(); } catch (e) { console.log(`  teardown ${n}: ${String(e?.message ?? e).slice(0, 90)}`); } };
    await step('contacts', () => prisma.marketingContact.deleteMany({ where: { vehicle_id: { in: fix.vehicles } } }));
    await step('edges', () => prisma.vehicleOwnership.deleteMany({ where: { vehicle_id: { in: fix.vehicles } } }));
    await step('vehicles', () => prisma.vehicle.deleteMany({ where: { id: { in: fix.vehicles } } }));
    await step('customer', () => (fix.customer ? prisma.customer.delete({ where: { id: fix.customer } }) : Promise.resolve()));
    check('teardown removed every fixture row (ZZ only)',
      (await prisma.vehicle.count({ where: { group_id: ZZ, id: { in: fix.vehicles } } })) === 0
      && (await prisma.customer.count({ where: { group_id: ZZ, name: 'Marketing Fixture' } })) === 0);
  }
}

console.log(`\n${out.filter((x) => x === 'F').length} failures of ${out.length}`);
await prisma.$disconnect();
process.exit(out.includes('F') ? 1 : 0);
