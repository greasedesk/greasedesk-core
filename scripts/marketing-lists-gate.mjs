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
const { gatePrisma, explainIfClientStale, zzSite, serverReady, describeError } = await import('./_gate-preflight.mjs');
import './_ts.mjs';
const { chromium } = await import('/Users/hugh/Developer/greasedesk-core/node_modules/playwright-core/index.mjs');
const M = await import('../lib/marketing-lists.ts');
const { readFileSync } = await import('node:fs');
const prisma = await gatePrisma();

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

  // ── THE FLAG THIS TYPE USED TO DROP ──────────────────────────────────────────────────────────
  // effectiveDueDate has always computed `alreadyPassed`; ServiceDue did not carry it, so every
  // caller saw "due today" and could not tell a car three weeks early from one months late. The
  // board read that as one band and put both in Warm. Asserted HERE, on serviceDue itself: the
  // board gate hands `overdue` straight to leadReasons, which proves the wording and would stay
  // green with the lift removed — it did.
  const past = M.serviceDue([item({ dueBasis: 'mileage', dueMileage: 40000 })], { ...noRate, currentMiles: 50000 });
  check('a car PAST its mileage target is flagged as passed', past[0]?.alreadyPassed === true,
    JSON.stringify(past[0] ?? null));
  const ahead = M.serviceDue([item({ dueBasis: 'mileage', dueMileage: 50400 })], withRate);
  check('  …and one still short of it is not', ahead[0]?.alreadyPassed === false,
    'both are "dated" and both are due — the flag is the only thing separating them');
  check('a date that has GONE is passed too', 
    M.serviceDue([item({ dueBasis: 'date', dueDate: '2020-01-01' })], noRate)[0]?.alreadyPassed === true,
    'same fact, the other leg — an overdue MOT-shaped service is not a different kind of late');
  check('  …while a future date is not', dated[0]?.alreadyPassed === false);
  check('a trigger-band item claims nothing it cannot evidence',
    M.serviceDue([item({ dueBasis: 'next_service' })], noRate)[0]?.alreadyPassed === false,
    '"due at the next service" IS overdue a visit, but there is no clock to read and a claim needs one');
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
  const site = await zzSite(prisma);
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
  await page.goto(`${BASE}/admin/marketing`, { waitUntil: 'domcontentloaded' });
  // THE PAGE IS A PIPELINE NOW, not two tabs of bands. The rule these assertions protected is
  // unchanged — a lapsed MOT is a better call than one three weeks away — so they follow it to
  // the new shape rather than being deleted with the old markup.
  await page.waitForSelector('[data-testid="stack-hot"]', { timeout: 25000 });

  check('the expired car is on the page', (await page.locator(`[data-testid="marketing-row-${expired.id}"]`).count()) === 1);
  // THE ORDER LIVES IN THE TAB STRIP NOW. This measured vertical position when the stacks were
  // stacked; with tabs only one is in the DOM at a time, so the rule it protects — a lapsed MOT is
  // a better call than one three weeks away — is expressed as Hot coming first, and landing there.
  check('  …and Hot comes before Warm, which comes before Later', (await page.evaluate(() => {
    const x = (t) => { const e = document.querySelector(`[data-testid="stack-tab-${t}"]`); return e ? e.getBoundingClientRect().left : null; };
    const [h, w, l] = ['hot', 'warm', 'later'].map(x);
    return h != null && w != null && l != null && h < w && w < l;
  })), 'a lapsed MOT is a better call than one three weeks away');
  check('  …and the expired car is in the HOT stack specifically', await page.evaluate((id) => {
    const hot = document.querySelector('[data-testid="stack-hot"]');
    return !!hot && !!hot.querySelector(`[data-testid="marketing-row-${id}"]`);
  }, expired.id));

  // ── THREE TABS, LANDING ON HOT ───────────────────────────────────────────────────────────────
  console.log('\n— the shape of the day, without clicking —');
  for (const k of ['hot', 'warm', 'later']) {
    check(`the ${k} tab carries its count`, /\(\d+\)/.test(await page.locator(`[data-testid="stack-tab-${k}"]`).innerText()),
      await page.locator(`[data-testid="stack-tab-${k}"]`).innerText());
  }
  check('  …and the counts match the stacks they name',
    (await page.locator('[data-testid="stack-count-hot"]').innerText()).replace(/[()]/g, '')
      === String((await page.locator('[data-testid="stack-hot"] [data-testid^="marketing-row-"]').count())),
    'a count that disagrees with the list under it is worse than no count');
  check('it lands on Hot', (await page.locator('[data-testid="stack-tab-hot"]').getAttribute('aria-selected')) === 'true');
  check('  …with only one stack rendered', (await page.locator('[data-testid="stack-warm"]').count()) === 0,
    'tabs, not a scroll — the point is seeing one thing at a time');

  // THE TAB IS IN THE URL, so a reload after recording a contact does not throw the caller back to
  // Hot — and so this gate drives the state rather than the strip.
  await page.goto(`${BASE}/admin/marketing?stack=warm`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-testid="stack-warm"]', { timeout: 25000 });
  check('the tab comes from the URL', (await page.locator('[data-testid="stack-tab-warm"]').getAttribute('aria-selected')) === 'true');
  check('  …and an unknown stack falls back to Hot rather than rendering nothing', await (async () => {
    await page.goto(`${BASE}/admin/marketing?stack=nonsense`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('[data-testid="stack-hot"]', { timeout: 25000 });
    return (await page.locator('[data-testid="stack-tab-hot"]').getAttribute('aria-selected')) === 'true';
  })());
  await page.goto(`${BASE}/admin/marketing`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-testid="stack-hot"]', { timeout: 25000 });
  const rowText = await page.locator(`[data-testid="marketing-row-${expired.id}"]`).innerText();
  check('the opted-out customer still appears', /Marketing Fixture/.test(rowText));
  check('  …marked "No texts", not silenced entirely', /No texts/.test(rowText), rowText.replace(/\n/g, ' | '));
  check('  …with the phone number shown', /01384 111222/.test(rowText), 'no opt-out covers a phone call');
  // ── THE COVERAGE LINE AND THE REVENUE TILE ARE GONE WITH THE OLD PAGE ───────────────────────
  // The tile said "£1,214 of work due" — four cars times the tenant's average job, describing none
  // of them, and rendered to every role with no permission check. It is replaced by a COUNT, so
  // the assertions that policed the figure are replaced by one that no figure exists.
  //
  // The three-number coverage line ("N of your M cars have no MOT date") is not lost: it belongs
  // to the fleet, not to the pipeline, and it is asserted against the DATABASE in the pure section
  // of this gate above. Removing it from a board about who to ring is deliberate — it answers a
  // different question from "who do I call today".
  const summary = await page.locator('[data-testid="board-summary"]').innerText();
  check('the board leads with a count, not a value', /worth ringing today/.test(summary) && !/£/.test(summary),
    summary.replace(/\n/g, ' | '));
  check('  …and no money appears anywhere on the page',
    !/£/.test(await page.locator('body').innerText()),
    'the tile it replaced was visible to a STANDARD mechanic with no check at all');

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
  check('gate run completed', false, describeError(e).slice(0, 300));
  await explainIfClientStale(BASE);
} finally {
  if (browser) await browser.close().catch(() => {});
  if (fix) {
    const step = async (n, f) => { try { await f(); } catch (e) { console.log(`  teardown ${n}: ${describeError(e).slice(0, 90)}`); } };
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
