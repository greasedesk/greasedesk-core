/**
 * File: scripts/marketing-board-gate.mjs
 * THE PIPELINE — three stacks, computed, and what moves a car between them.
 *
 * The board it replaces was a two-tab list with "£1,214 of work due" at the top: four cars times
 * the tenant's average job, a figure describing none of them, rendered to a STANDARD mechanic with
 * no permission check at all. What is asserted here is the ordering, the movement, and that no
 * money reaches the shape.
 *
 * Fixtures on ZZ Gate Garage only. Never TMBS.
 */
import './_gate-preflight.mjs';
const { explainIfClientStale, serverReady } = await import('./_gate-preflight.mjs');
import './_ts.mjs';
const { PrismaClient } = await import('@prisma/client');
const { readFileSync } = await import('node:fs');
const { chromium } = await import('playwright-core');
const P = await import('../lib/marketing-pipeline.ts');
const B = await import('../lib/marketing-board.ts');
const prisma = new PrismaClient();

const ZZ = 'c75ac44e-250a-4c90-98ba-a8326e98dad5';
const CUST = 'Board Pipeline Fixture';
const out = [];
const check = (n, ok, d = '') => { out.push(ok ? 'P' : 'F'); console.log(`${ok ? '✓' : '✗'} ${n}${d ? `  — ${d}` : ''}`); };
const NOW = new Date('2026-08-21T10:00:00Z');
const base = { motBand: null, motDays: null, battery: null, lowestTreadTenths: null, findings: [], contact: null };

let fix = null;
let browser = null;
const BASE = process.env.GATE_BASE ?? 'http://localhost:3000';

try {
  const stale = await prisma.customer.count({ where: { group_id: ZZ, name: CUST } });
  if (stale) throw new Error(`REFUSING: ${stale} fixture(s) from a previous run still present`);

  // ── 1. WHAT MAKES A LEAD HOT ─────────────────────────────────────────────────────────────────
  console.log('\n— money available this week —');
  check('an expired MOT is hot', P.leadStack({ ...base, motBand: 'expired', motDays: -62 }, NOW).stack === 'hot');
  check('  …and says how long it has been off the road',
    /62 days ago/.test(P.leadStack({ ...base, motBand: 'expired', motDays: -62 }, NOW).reasons[0].text));
  check('  …and "expires today" is not "0 days ago"',
    /expires today/.test(P.leadStack({ ...base, motBand: 'expired', motDays: -0.2 }, NOW).reasons[0].text),
    'a rounding produced a sentence nobody says');
  check('a failed battery is hot', P.leadStack({ ...base, battery: 'replace' }, NOW).stack === 'hot');
  check('  …and a dead cell', P.leadStack({ ...base, battery: 'dead_cell' }, NOW).stack === 'hot');
  check('an illegal tyre is hot', P.leadStack({ ...base, lowestTreadTenths: 15 }, NOW).stack === 'hot');
  check('  …and 1.6mm exactly is NOT, because that is legal',
    P.leadStack({ ...base, lowestTreadTenths: 16 }, NOW).stack !== 'hot', 'the limit is a floor, not a threshold to cross');
  check('a job the customer agreed to and nobody booked is hot',
    P.leadStack({ ...base, findings: [{ description: 'Rear pads', response: 'agreed_later', dueWithinWindow: false }] }, NOW).stack === 'hot',
    'the purest lead there is: they already said yes');

  // ── 2. THE REFUSAL THAT MUST NOT BE SOLD ─────────────────────────────────────────────────────
  console.log('\n— a retest is not a sale —');
  const retest = P.leadStack({ ...base, battery: 'retest' }, NOW);
  check('an inconclusive battery is WARM, not hot', retest.stack === 'warm',
    'low charge and low health together: the code refuses to guess, and so must the board');
  check('  …and never says the customer needs a battery',
    !/need|failed|replace/i.test(retest.reasons[0].text), retest.reasons[0].text);
  check('  …it says get it back in and test it properly', /test it properly/.test(retest.reasons[0].text));
  const charging = P.leadStack({ ...base, battery: 'charging_fault' }, NOW);
  check('a charging fault is warm and blames the charging, not the battery',
    charging.stack === 'warm' && /charging did not/.test(charging.reasons[0].text), charging.reasons[0].text);
  check('a battery worth watching is not a lead at all',
    P.leadStack({ ...base, battery: 'monitor' }, NOW).reasons.length === 0,
    'monitor is a note on a document, not a phone call');

  // ── PAST IT IS NOT THE SAME AS COMING UP ─────────────────────────────────────────────────────
  // A car months past its service mileage was sitting in Warm beside one due in three weeks. Not a
  // wording problem: effectiveDueDate computed `alreadyPassed` and serviceDue's return type DROPPED
  // it, so nothing downstream could see the difference. The MOT pair in this same file was already
  // right — expired Hot, due Warm — which is the shape this now mirrors.
  console.log('\n— overdue servicing is hot —');
  const F = (over) => ({ description: 'Rear brake pads', response: 'not_raised', dueWithinWindow: true, overdue: over });
  const soon = P.leadStack({ ...base, findings: [F(false)] }, NOW);
  check('a service due soon is warm', soon.stack === 'warm' && soon.reasons.some((r) => r.kind === 'service_due'),
    JSON.stringify(soon.reasons.map((r) => [r.kind, r.stack])));
  const past = P.leadStack({ ...base, findings: [F(true)] }, NOW);
  check('a service already PAST is hot', past.stack === 'hot' && past.reasons.some((r) => r.kind === 'service_overdue'),
    JSON.stringify(past.reasons.map((r) => [r.kind, r.stack])));
  check('  …and says overdue, not due', /overdue/.test(past.reasons.find((r) => r.kind === 'service_overdue').text),
    past.reasons.find((r) => r.kind === 'service_overdue').text);
  const both = P.leadStack({ ...base, findings: [F(true), F(false)] }, NOW);
  check('a car with one of each raises BOTH reasons', both.stack === 'hot'
    && both.reasons.some((r) => r.kind === 'service_overdue') && both.reasons.some((r) => r.kind === 'service_due'),
    'the overdue one decides the stack; the other is still a job worth mentioning on the call');
  check('  …and a DECLINED overdue job is not a lead',
    P.leadStack({ ...base, findings: [{ ...F(true), response: 'declined' }] }, NOW).reasons
      .every((r) => r.kind !== 'service_overdue'),
    'the customer already said no — the same rule the due-soon side has always had');
  check('the new reason is a DECLARED kind, so a contact can record it',
    P.LEAD_REASON_KINDS.includes('service_overdue'));
  // THE LIST AND THE CONSTRAINT ARE TWO DIFFERENT THINGS. Adding a kind in TypeScript and not in
  // the database gives a board that shows a reason nobody can then record against — the failure
  // arrives at the moment a garage rings the customer, which is the worst place to find it.
  const [{ def }] = await prisma.$queryRawUnsafe(
    `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'MarketingContact_reason_check'`);
  const inDb = [...String(def).matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
  check('  …and the DATABASE agrees, kind for kind',
    P.LEAD_REASON_KINDS.every((k) => inDb.includes(k)) && inDb.every((k) => P.LEAD_REASON_KINDS.includes(k)),
    `code: ${P.LEAD_REASON_KINDS.length}, db: ${inDb.length}${inDb.includes('service_overdue') ? '' : ' — service_overdue MISSING from the CHECK'}`);

  // ── 3. THE MOVEMENT RULE ─────────────────────────────────────────────────────────────────────
  console.log('\n— what stops Hot becoming a graveyard —');
  const hotDeclined = P.leadStack({ ...base, motBand: 'expired', motDays: -62,
    contact: { state: 'declined', snoozeUntil: null, contactStands: true } }, NOW);
  check('a hot lead contacted and declined drops to Later', hotDeclined.stack === 'later');
  check('  …keeping the reason it was hot, so nobody loses the thread',
    hotDeclined.reasons.some((r) => r.kind === 'mot_expired'));
  // A DECLINE IS TERMINAL. It used to expire like a snooze, so a customer who said no was rung
  // again a month later by a board that had forgotten. `contactStands` is not consulted for a
  // decline at all — no clock, no dueDate, no coming back.
  const lapsed = P.leadStack({ ...base, motBand: 'expired', motDays: -62,
    contact: { state: 'declined', snoozeUntil: null, contactStands: false } }, NOW);
  check('  …and a decline does NOT come back when its clock runs out', lapsed.stack === 'later',
    'the customer said no; an expiring record is not new information');
  // The SNOOZE keeps exactly the behaviour the decline is losing — that is the whole distinction.
  const snoozeLapsed = P.leadStack({ ...base, motBand: 'expired', motDays: -62,
    contact: { state: 'snoozed', snoozeUntil: new Date('2026-07-01'), contactStands: false } }, NOW);
  check('  …while a lapsed SNOOZE still lets the signal speak again', snoozeLapsed.stack === 'hot',
    '"ask me later" has a later; "no" does not');
  const snoozed = P.leadStack({ ...base, motBand: 'due', motDays: 20,
    contact: { state: 'snoozed', snoozeUntil: new Date('2026-09-30'), contactStands: true } }, NOW);
  check('a live snooze holds a car down', snoozed.stack === 'later' && /Snoozed until 30 September/.test(snoozed.reasons[0].text));
  check('being contacted can only push a car DOWN, never up',
    P.leadStack({ ...base, findings: [{ description: 'x', response: 'declined', dueWithinWindow: false }],
      contact: { state: 'contacted', snoozeUntil: null, contactStands: true } }, NOW).stack === 'later',
    'a car cannot be promoted by having been rung');

  // TIME PROMOTES, and nothing has to notice.
  console.log('\n— time promotes, with nothing scheduled —');
  const warmAt31 = P.leadStack({ ...base, motBand: 'due', motDays: 31 }, NOW);
  const hotWhenExpired = P.leadStack({ ...base, motBand: 'expired', motDays: -1 }, NOW);
  check('the same car is warm at 31 days and hot once expired',
    warmAt31.stack === 'warm' && hotWhenExpired.stack === 'hot');
  const src = readFileSync('lib/marketing-board.ts', 'utf8') + readFileSync('lib/marketing-pipeline.ts', 'utf8');
  check('  …and no stack is ever stored', !/stack:\s*(?:'hot'|'warm'|'later')\s*,?\s*\n?\s*\}\s*\)/.test(src)
    && !/data:\s*\{[^}]*stack/.test(src),
    'a stored stack is wrong between writes and needs something to sweep it');

  // ── 4. NO MONEY IN THE SHAPE ─────────────────────────────────────────────────────────────────
  console.log('\n— a count is true; an average describes nobody —');
  const board = readFileSync('lib/marketing-board.ts', 'utf8');
  const page = readFileSync('pages/admin/marketing.tsx', 'utf8');
  check('the board shape carries no money field',
    !/pennies|revenue|averagePennies|currency/i.test(board.replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, '')),
    'not a gated field — no field. There is nothing to leak.');
  check('  …and the page renders no figure', !/money\(|formatMoney/.test(page.replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, '')),
    'it rendered £1,214 to a STANDARD mechanic with no check at all');
  check('  …and the reason is written where the tile used to be', /A COUNT, NOT A VALUE/.test(page));

  // ── 5. THE BOARD EXPLAINS ITS OWN EMPTINESS ──────────────────────────────────────────────────
  console.log('\n— an empty Hot stack is usually an unasked question —');
  // ONE SENTENCE, both cases. On the tabbed board the empty Hot tab already says "Nothing hot
  // right now", so a prompt that opened with the same words said it twice and buried the half
  // that matters. The pair on an empty tab IS the whole screen.
  check('the prompt says what changes the position, not what it is',
    /each yes puts a car in Hot/.test(P.unansweredPrompt(0, 15) ?? ''), P.unansweredPrompt(0, 15));
  check('  …and does not repeat what the empty tab already says',
    !/Nothing hot/.test(P.unansweredPrompt(0, 15) ?? ''), P.unansweredPrompt(0, 15));
  check('  …reading the same with hot leads present', P.unansweredPrompt(6, 12) === P.unansweredPrompt(0, 12));
  check('  …and one finding is singular', /1 finding is waiting/.test(P.unansweredPrompt(0, 1) ?? ''),
    P.unansweredPrompt(0, 1));
  check('  …and says nothing when there is nothing to say', P.unansweredPrompt(3, 0) === null,
    'a prompt about zero findings is noise');

  // ── 6. AGAINST REAL DATA, INCLUDING HOW LONG IT TAKES ────────────────────────────────────────
  console.log('\n— built on a throwaway car, and timed —');
  const cust = await prisma.customer.create({ data: { group_id: ZZ, name: CUST, phone: '07700 900112' }, select: { id: true } });
  const veh = await prisma.vehicle.create({
    data: { group_id: ZZ, registration: 'ZZ76BRD', registration_normalized: 'ZZ76BRD', make: 'Board', model: 'Fixture',
      mot_expiry: new Date('2026-06-01T00:00:00.000Z') }, select: { id: true } });
  await prisma.vehicleOwnership.create({ data: { vehicle_id: veh.id, customer_id: cust.id, is_current: true } });
  fix = { veh: veh.id, cust: cust.id, contactVehicles: [] };

  const t0 = Date.now();
  const built = await B.buildBoard(ZZ, NOW);
  const ms = Date.now() - t0;
  const row = built.hot.find((r) => r.registration === 'ZZ76BRD');
  check('an expired car lands in Hot', !!row, built.hot.map((r) => r.registration).join(', '));
  check('  …with the phone number, whatever the role', row?.phone === '07700 900112',
    'no opt-out covers a phone call and no role gate covers ringing');
  check('  …and no money anywhere on the row',
    !Object.keys(row ?? {}).some((k) => /pennies|price|value|revenue/i.test(k)), Object.keys(row ?? {}).join(' '));
  // ── NO QUERY INSIDE THE PER-CAR LOOP ────────────────────────────────────────────────────────
  // Asserted STRUCTURALLY, because a timing budget cannot catch this where the gate runs: ZZ has a
  // handful of cars, so the N+1 version builds in milliseconds here and only bites on a real
  // fleet. Reintroducing a per-vehicle findMany passed the clock check clean. The rule is "one
  // read per collection, not one per car", and that is a property of the source.
  const boardSrc = readFileSync('lib/marketing-board.ts', 'utf8');
  const loopStart = boardSrc.indexOf('for (const v of vehicles) {');
  const loopEnd = boardSrc.indexOf('  const pick = (s: Stack)');
  const loopBody = boardSrc.slice(loopStart, loopEnd);
  const queriesInLoop = [...loopBody.matchAll(/await\s+prisma\.(\w+)\./g)].map((m) => m[1]);
  check('no database read happens inside the per-car loop', queriesInLoop.length === 0,
    queriesInLoop.length ? `prisma.${[...new Set(queriesInLoop)].join(', prisma.')} — one read per CAR is 600 round trips on a 222-car fleet` : 'every collection is fetched once and grouped in memory');
  // The clock stays as a coarse backstop, and its limits are stated rather than implied.
  check(`and the board builds quickly on the fixture tenant (${(ms / 1000).toFixed(1)}s)`, ms < 4000,
    'a weak check here by construction — ZZ is small; the structural assertion above is the real one');

  // ── 7. WHAT A RECORDED CONTACT DOES TO A CAR'S PLACEMENT ─────────────────────────────────────
  // Asserted through buildBoard against REAL MarketingContact rows, because the checks in section 3
  // hand the flag to leadStack by hand. They prove the demotion RULE and never touch the derivation
  // that decides which way it points — so the board could disagree with every one of them and they
  // would all stay green. They did.
  //
  // The rows are written by POSTing to /api/marketing-contact, not by prisma.create: the endpoint
  // derives for_date and snooze_until server-side, and a hand-built row would be testing a shape
  // no user can produce.
  console.log('\n— a recorded contact, through the endpoint, against the real board —');
  const mk = async (reg) => {
    const v = await prisma.vehicle.create({
      data: { group_id: ZZ, registration: reg, registration_normalized: reg, make: 'Board', model: 'Contact',
        mot_expiry: new Date('2026-06-01T00:00:00.000Z') }, select: { id: true } });
    await prisma.vehicleOwnership.create({ data: { vehicle_id: v.id, customer_id: cust.id, is_current: true } });
    fix.contactVehicles.push(v.id);
    return v.id;
  };
  // Registration order deliberately OPPOSITE to urgency order, so a sort by one cannot pass by
  // accidentally producing the other. ZZ76AAA is the stalest MOT and sorts FIRST by reg, LAST by
  // urgency; ZZ76ZZY is the nearest and does the reverse.
  const mkDated = async (reg, expiry) => {
    const v = await prisma.vehicle.create({
      data: { group_id: ZZ, registration: reg, registration_normalized: reg, make: 'Board', model: 'Sort',
        mot_expiry: new Date(expiry) }, select: { id: true } });
    await prisma.vehicleOwnership.create({ data: { vehicle_id: v.id, customer_id: cust.id, is_current: true } });
    fix.contactVehicles.push(v.id);
    return v.id;
  };
  await mkDated('ZZ76AAA', '2025-01-01T00:00:00.000Z');   // ~600 days expired → high urgency
  await mkDated('ZZ76ZZY', '2026-08-19T00:00:00.000Z');   // expired 2 days ago → Hot, low urgency
  // A GENUINE TIE, because the reload check above is vacuous without one: identical urgency is the
  // only thing that exposes the unordered vehicles query underneath. Created in the order that
  // would produce the WRONG answer if the tiebreak were dropped.
  await mkDated('ZZ76TIB', '2026-05-05T00:00:00.000Z');
  await mkDated('ZZ76TIA', '2026-05-05T00:00:00.000Z');

  const declinedToday = await mk('ZZ76DEC');
  const snoozedCar = await mk('ZZ76SNZ');
  const declinedOld = await mk('ZZ76OLD');

  // The dev server disposes inactive pages and serves 404s while it rebuilds one; a gate that
  // drives a page that was never served dies as a bare selector timeout 25s later. Warm it and
  // say so — see serverReady in _gate-preflight.
  const ready = await serverReady();
  check('the dev server serves pages before we drive it', ready.ok, `HTTP ${ready.status} after ${ready.attempts} attempt(s)`);
  browser = await chromium.launch({ channel: 'chrome' });
  const contactPage = await (await browser.newContext()).newPage();
  await contactPage.goto(`${BASE}/admin/login`, { waitUntil: 'domcontentloaded' });
  await contactPage.fill('input[type="email"]', 'owner@zzgategarage.test');
  await contactPage.fill('input[type="password"]', 'GateGarage!2026');
  await Promise.all([contactPage.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 60000 }), contactPage.click('button[type="submit"]')]);
  const record = (vehicleId, state) => contactPage.evaluate(async (b) => {
    const r = await fetch('/api/marketing-contact', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin', body: JSON.stringify(b) });
    return { status: r.status, body: await r.json().catch(() => ({})) };
  }, { vehicleId, reason: 'mot_expired', state, forDate: '2026-06-01' });

  const rDec = await record(declinedToday, 'declined');
  const rSnz = await record(snoozedCar, 'snoozed');
  const rOld = await record(declinedOld, 'declined');
  check('the endpoint records all three', [rDec, rSnz, rOld].every((r) => r.status === 200),
    JSON.stringify([rDec.status, rSnz.status, rOld.status]));
  check('  …and the SERVER set the snooze, as it does for a real garage', rSnz.body.snoozeUntil != null,
    'a snooze with no end is a hide, so the client cannot omit it — the fixture must not either');

  // ONLY THE AGE IS FABRICATED. The row's shape is the endpoint's; created_at cannot be sixty days
  // old on a row written a second ago, and the whole question for this case is what happens once a
  // contact has outlived the thing it was about.
  await prisma.marketingContact.updateMany({ where: { vehicle_id: declinedOld },
    data: { created_at: new Date(NOW.getTime() - 60 * 86_400_000), for_date: new Date(NOW.getTime() - 60 * 86_400_000) } });

  const after = await B.buildBoard(ZZ, NOW);
  const whereIs = (reg) => ['hot', 'warm', 'later'].find((k) => after[k].some((r) => r.registration === reg)) ?? 'absent';
  check('a car declined TODAY drops to Later', whereIs('ZZ76DEC') === 'later',
    `it is in ${whereIs('ZZ76DEC')} — a garage that recorded "not this time" is looking at the car again`);
  check('a car snoozed to a future date drops to Later', whereIs('ZZ76SNZ') === 'later',
    `it is in ${whereIs('ZZ76SNZ')} — the snooze is not holding it down`);
  check('a car declined 60 DAYS ago STAYS in Later', whereIs('ZZ76OLD') === 'later',
    `it is in ${whereIs('ZZ76OLD')} — a customer who said no should not resurface because the record aged`);
  // ── 8. URGENCY, AND THE STRIP THAT SORTS BY IT ───────────────────────────────────────────────
  console.log('\n— a number that exists for every row —');
  const U = (reg) => (after.hot.find((r) => r.registration === reg) ?? after.warm.find((r) => r.registration === reg))?.urgency;
  check('every row on the board carries an urgency, with no nulls',
    [...after.hot, ...after.warm, ...after.later].every((r) => typeof r.urgency === 'number' && Number.isFinite(r.urgency)),
    'the value is defined for undated rows too — that was the point of adding it');
  check('a stale MOT scores higher than a near one', (U('ZZ76AAA') ?? 0) > (U('ZZ76ZZY') ?? 0),
    `ZZ76AAA=${U('ZZ76AAA')} ZZ76ZZY=${U('ZZ76ZZY')}`);
  // The bands, proved on the pure function where every input is visible.
  const measured = P.leadStack({ ...base, battery: 'replace' }, NOW);
  const dated = P.leadStack({ ...base, motBand: 'due', motDays: 1 }, NOW);
  check('a measured fault outranks every clock', measured.urgency === P.URGENCY_MEASURED && measured.urgency < dated.urgency,
    `battery=${measured.urgency} vs an MOT due TOMORROW=${dated.urgency}`);
  check('  …and expiring tomorrow ranks next to expired yesterday',
    P.leadStack({ ...base, motBand: 'due', motDays: 1 }, NOW).urgency
      === P.leadStack({ ...base, motBand: 'expired', motDays: -1 }, NOW).urgency,
    'unsigned distance from now — both are AT the boundary, which is what makes them worth ringing');
  check('  …so a car long expired sinks rather than leads',
    P.leadStack({ ...base, motBand: 'expired', motDays: -274 }, NOW).urgency > dated.urgency,
    'the visible consequence of the unsigned rule, asserted so it is a decision and not a surprise');
  check('a dated reason with NO clock sorts last among dated, not first',
    P.leadStack({ ...base, findings: [{ description: 'x', response: 'not_raised', dueWithinWindow: true, overdue: false }],
      serviceDueDays: null }, NOW).urgency === P.URGENCY_NO_CLOCK,
    'not knowing when must not jump the queue');

  console.log('\n— the strip that sorts —');
  await contactPage.goto(`${BASE}/admin/marketing?stack=hot`, { waitUntil: 'domcontentloaded' });
  await contactPage.waitForSelector('[data-testid="sort-strip"]');
  const order = () => contactPage.$$eval('li[data-reg]', (ns) => ns.map((n) => n.getAttribute('data-reg')));
  const pos = (list, reg) => list.indexOf(reg);
  const byUrgency = await order();
  check('the default order is urgency, closest first', pos(byUrgency, 'ZZ76ZZY') < pos(byUrgency, 'ZZ76AAA'),
    byUrgency.join(' '));
  check('  …and the strip says so without being clicked',
    (await contactPage.locator('[data-testid="sort-dir-urgency"]').innerText()).trim() === '↑');
  await contactPage.click('[data-testid="sort-registration"]');
  await contactPage.waitForTimeout(300);
  const byReg = await order();
  check('clicking Reg sorts by registration', pos(byReg, 'ZZ76AAA') < pos(byReg, 'ZZ76ZZY'), byReg.join(' '));
  check('  …which is the OPPOSITE of urgency order, so it cannot have passed by coincidence',
    pos(byUrgency, 'ZZ76AAA') > pos(byUrgency, 'ZZ76ZZY') && pos(byReg, 'ZZ76AAA') < pos(byReg, 'ZZ76ZZY'));
  await contactPage.click('[data-testid="sort-registration"]');
  await contactPage.waitForTimeout(300);
  const reversed = await order();
  check('clicking it again reverses', pos(reversed, 'ZZ76AAA') > pos(reversed, 'ZZ76ZZY'), reversed.join(' '));
  check('  …and the sort rides in the URL beside the tab, not in component state',
    /stack=hot/.test(contactPage.url()) && /sort=registration/.test(contactPage.url()) && /dir=desc/.test(contactPage.url()),
    contactPage.url());
  // A RELOAD MUST NOT RESHUFFLE. Urgency ties are common and the underlying query has no ORDER BY,
  // so without a deterministic tiebreak a "sorted" list quietly reorders between page loads.
  await contactPage.goto(`${BASE}/admin/marketing?stack=hot`, { waitUntil: 'domcontentloaded' });
  await contactPage.waitForSelector('[data-testid="sort-strip"]');
  const again = await order();
  check('two cars with the SAME urgency exist, or the reload check below proves nothing',
    U('ZZ76TIA') === U('ZZ76TIB') && U('ZZ76TIA') != null, `TIA=${U('ZZ76TIA')} TIB=${U('ZZ76TIB')}`);
  check('  …and the tie breaks on registration, not on whatever the query returned',
    pos(byUrgency, 'ZZ76TIA') < pos(byUrgency, 'ZZ76TIB'),
    `${byUrgency.join(' ')} — TIB was created FIRST, so insertion order would put it first`);
  check('the same order comes back on a reload', JSON.stringify(again) === JSON.stringify(byUrgency),
    `${byUrgency.join(' ')}  vs  ${again.join(' ')}`);

  // ── 9. THE GARAGE RECORDS THE ANSWER, AND THE CAR MOVES ──────────────────────────────────────
  // Every finding on every tenant is `not_raised` — 88 of them — because nothing can change one
  // after it is created. The two API writers set the response at CREATE, at the car, before anyone
  // has spoken to the customer; the only thing that can change it afterwards is the customer's own
  // tap on an intake report, and one report has ever been sent.
  //
  // Driven through the REAL PATCH endpoint, not by writing rows: the question is whether the
  // endpoint moves the car, and a hand-written update would prove only that the board reads a
  // column.
  console.log('\n— a garage-recorded answer moves the car —');
  const answerCar = await mk('ZZ76ANS');
  // MOT four days out, so the car sits in WARM on its own. Whatever the finding does has to be
  // visible against that: "leaves the car's other reasons standing" needs another reason to stand.
  await prisma.vehicle.update({ where: { id: answerCar }, data: { mot_expiry: new Date(NOW.getTime() + 4 * 86_400_000) } });
  const finding = await prisma.vehicleDueItem.create({
    data: { group_id: ZZ, vehicle_id: answerCar, description: 'Rear discs corroded',
      due_basis: 'mileage', due_mileage: 90000, due_date_precision: 'day',
      timing_in_description: false, customer_response: 'not_raised' },
    select: { id: true } });

  const respond = (response) => contactPage.evaluate(async (b) => {
    const r = await fetch('/api/due-items', { method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin', body: JSON.stringify(b) });
    return { status: r.status, body: await r.json().catch(() => ({})) };
  }, { action: 'respond', id: finding.id, response });

  const stackOf = async (reg) => {
    const b = await B.buildBoard(ZZ, NOW);
    const k = ['hot', 'warm', 'later'].find((x) => b[x].some((r) => r.registration === reg));
    const row = k ? b[k].find((r) => r.registration === reg) : null;
    return { stack: k ?? 'absent', reasons: (row?.reasons ?? []).map((r) => r.kind), urgency: row?.urgency };
  };

  check('the car starts in Warm, unanswered', (await stackOf('ZZ76ANS')).stack === 'warm',
    JSON.stringify(await stackOf('ZZ76ANS')));

  const rAgreed = await respond('agreed_later');
  const afterAgreed = await stackOf('ZZ76ANS');
  check('agreed_later puts the car in Hot', rAgreed.status === 200 && afterAgreed.stack === 'hot',
    `${rAgreed.status} → ${JSON.stringify(afterAgreed)}`);

  const rDeclined = await respond('declined');
  const afterDeclined = await stackOf('ZZ76ANS');
  check('declined takes it OUT of Hot', rDeclined.status === 200 && afterDeclined.stack !== 'hot',
    `${rDeclined.status} → ${JSON.stringify(afterDeclined)}`);
  // THE DISTINCTION THIS SLICE IS ABOUT. A declined FINDING removes one job from consideration; a
  // declined CONTACT is terminal for the whole car. The MOT must still be standing here.
  // TIED TO THE TRANSITION HAVING HAPPENED. On its own this passes whenever the car is in Warm —
  // including when the PATCH did nothing at all and the car never moved, which is how it read green
  // against an endpoint that rejected every request.
  const declinedInDb = (await prisma.vehicleDueItem.findUnique({ where: { id: finding.id }, select: { customer_response: true } }))?.customer_response;
  check('  …and the car\'s other reasons still stand', declinedInDb === 'declined' && afterDeclined.reasons.includes('mot_due'),
    `stored=${declinedInDb}, reasons: ${afterDeclined.reasons.join(',')} — a declined finding is not a declined car`);

  const rCall = await respond('wants_call');
  const afterCall = await stackOf('ZZ76ANS');
  check('wants_call produces a reason of its own', rCall.status === 200 && afterCall.reasons.some((k) => /call/.test(k)),
    `${rCall.status} → ${JSON.stringify(afterCall)}`);
  check('  …and it is HOT — the customer asked to be rung', afterCall.stack === 'hot', afterCall.stack);

  const rRevert = await respond('not_raised');
  // THE STATUS IS NOT ENOUGH. Before the respond action existed this read 400 `bad_kind` — "Say why
  // this is being closed" — because every PATCH fell through to the CLOSE branch. Green, for a
  // refusal that had nothing to do with the answer. The refusal has to be ABOUT the revert.
  check('reverting to not_raised is REFUSED', rRevert.status === 400 && rRevert.body?.code === 'bad_response',
    `${rRevert.status} ${JSON.stringify(rRevert.body).slice(0, 140)} — "we never asked" after you did ask is a false statement`);
  const stillCall = await prisma.vehicleDueItem.findUnique({ where: { id: finding.id }, select: { customer_response: true, response_at: true } });
  check('  …and the answer is unchanged by the refusal', stillCall.customer_response === 'wants_call' && stillCall.response_at != null,
    JSON.stringify(stillCall));

  check('  …and the declined car keeps the reason it was hot for',
    (after.later.find((r) => r.registration === 'ZZ76DEC')?.reasons ?? []).some((r) => r.kind === 'mot_expired'),
    'nobody loses the thread of why it was on the list');
} catch (e) {
  check('gate run completed', false, String(e?.message ?? e).slice(0, 300));
  await explainIfClientStale(process.env.GATE_BASE ?? 'http://localhost:3000');
} finally {
  if (browser) await browser.close().catch(() => {});
  if (fix) {
    const step = async (n, fn) => { try { await fn(); } catch (e) { console.log(`  teardown ${n}: ${String(e?.message ?? e).slice(0, 90)}`); } };
    const CONTACT_REGS = ['ZZ76DEC', 'ZZ76SNZ', 'ZZ76OLD', 'ZZ76AAA', 'ZZ76ZZY', 'ZZ76TIA', 'ZZ76TIB', 'ZZ76ANS'];
    await step('findings', () => prisma.vehicleDueItem.deleteMany({ where: { group_id: ZZ, vehicle_id: { in: fix.contactVehicles ?? [] } } }));
    await step('contacts', () => prisma.marketingContact.deleteMany({ where: { group_id: ZZ, vehicle_id: { in: fix.contactVehicles ?? [] } } }));
    await step('contact edges', () => prisma.vehicleOwnership.deleteMany({ where: { vehicle_id: { in: fix.contactVehicles ?? [] } } }));
    await step('contact vehicles', () => prisma.vehicle.deleteMany({ where: { group_id: ZZ, registration: { in: CONTACT_REGS } } }));
    await step('edges', () => prisma.vehicleOwnership.deleteMany({ where: { vehicle_id: fix.veh } }));
    await step('vehicle', () => prisma.vehicle.deleteMany({ where: { group_id: ZZ, registration: 'ZZ76BRD' } }));
    await step('customer', () => prisma.customer.deleteMany({ where: { group_id: ZZ, name: CUST } }));
    check('teardown removed every fixture row (ZZ only)',
      (await prisma.vehicle.count({ where: { group_id: ZZ, registration: 'ZZ76BRD' } })) === 0
      && (await prisma.vehicle.count({ where: { group_id: ZZ, registration: { in: ['ZZ76DEC', 'ZZ76SNZ', 'ZZ76OLD', 'ZZ76AAA', 'ZZ76ZZY', 'ZZ76TIA', 'ZZ76TIB', 'ZZ76ANS'] } } })) === 0
      && (await prisma.marketingContact.count({ where: { group_id: ZZ, vehicle_id: { in: fix.contactVehicles ?? [] } } })) === 0
      && (await prisma.customer.count({ where: { group_id: ZZ, name: CUST } })) === 0);
  }
}

console.log(`\n${out.filter((x) => x === 'F').length} failures of ${out.length}`);
await prisma.$disconnect();
process.exit(out.includes('F') ? 1 : 0);
