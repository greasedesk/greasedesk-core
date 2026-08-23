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
const { explainIfClientStale, zzSite, serverReady } = await import('./_gate-preflight.mjs');
import './_ts.mjs';
const { PrismaClient } = await import('@prisma/client');
const { chromium } = await import('/Users/hugh/Developer/greasedesk-core/node_modules/playwright-core/index.mjs');
const S = await import('../lib/service-schedule.ts');
const D = await import('../lib/due-items.ts');
const { readFileSync } = await import('node:fs');
const { freezeQuoteVersion } = await import('../lib/quote-version.ts');
const { acceptQuote } = await import('../lib/quote-acceptance.ts');
const { issueInvoiceForCard } = await import('../lib/invoice-issue.ts');
const prisma = new PrismaClient();

const ZZ = 'c75ac44e-250a-4c90-98ba-a8326e98dad5';
const BASE = process.env.GATE_BASE ?? 'http://localhost:3000';
const CUST = 'Schedule Fixture Owner';
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
  // CORRECTED 2026-08-20. It shipped as `date` on the argument that a check is a touchpoint booked
  // by date — which describes how the appointment is made, not when the car becomes due.
  check('a vehicle check is BOTH, like the oil service', by('schedule_vehicle_check') === 'whichever_first',
    'an inspection interval is months OR miles, and a car doing 30,000 a year gets there first');
  check('  …so it demands both legs, and refuses half of one',
    S.refuseSchedule([{ key: 'schedule_vehicle_check', dueMonth: '2027-08', dueMileage: null,
      item: S.SCHEDULE_ITEMS.find((i) => i.key === 'schedule_vehicle_check') }])[0]?.code === 'incomplete',
    'one leg alone is a different basis and loses the trigger that would have fired first');
  check('  …and the reversal is left visible in the source',
    /CORRECTED 2026-08-20/.test(readFileSync('lib/service-schedule.ts', 'utf8')),
    'the original reasoning is the useful part — a why that was wrong teaches more than one that was never written');
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
  // ── THE TWO SENTENCES A BLANK ROW CAN BE, PROVED WITHOUT A ROW ───────────────────────────────
  const oilItem = S.scheduleByKey('schedule_oil_service');
  check('a filled row records', S.classifyEntry(oilItem, { dueMonth: '2027-07', dueMileage: 1000 }) === 'record');
  check('a blank row the form HELD is a clear', S.classifyEntry(oilItem, { dueMonth: null, dueMileage: null, wasRecorded: true }) === 'clear');
  check('a blank row the form never held is a skip', S.classifyEntry(oilItem, { dueMonth: null, dueMileage: null, wasRecorded: false }) === 'skip');
  check('  …and so is one that says nothing either way', S.classifyEntry(oilItem, { dueMonth: null, dueMileage: null }) === 'skip',
    'absent is unknown, and unknown never deletes — a queued offline save replays in its old shape');
  check('  …but a claim cannot resurrect a row that has values', S.classifyEntry(oilItem, { dueMonth: '2027-07', dueMileage: 1000, wasRecorded: false }) === 'record',
    'wasRecorded only ever decides what a BLANK means; it is not a switch over the whole entry');
  check('the reason a skip happened is a sentence, available to both callers',
    /did not report holding a reading/.test(S.SKIPPED_BLANK_REASON));

  // ── SAY THE GAP OUT LOUD, IN THE GREEN OUTPUT ────────────────────────────────────────────────
  // Everything above is about a form seeded with NOTHING. A form seeded with STALE VALUES has
  // wasRecorded legitimately true and overwrites newer data with older — the version of this that
  // survives BOTH fixes, and the one a reader will assume these ticks cover. A caveat that lives
  // only in a source comment is not read by the person looking at a green run, so it is asserted
  // here and printed beside the rest.
  const src = readFileSync('lib/service-schedule.ts', 'utf8');
  check('the LOST-UPDATE gap is recorded where classifyEntry is defined',
    /WHAT THIS DOES NOT COVER/.test(src) && /STALE VALUES/.test(src) && /lost update/.test(src),
    'a form seeded with stale VALUES still overwrites newer data with older — not covered here, needs a version or an echoed seed value');

  // ── A COUNTDOWN IS WHAT THE SCREEN SHOWS; A TARGET IS WHAT WE STORE ──────────────────────────
  console.log('\n— the countdown —');
  check('a countdown behind the car converts to a target behind it',
    JSON.stringify(S.resolveCountdown(-240, 68360, 'departure')) === '{"ok":true,"dueMileage":68120}');
  check('  …and an ordinary one ahead of it converts too',
    JSON.stringify(S.resolveCountdown(1240, 68360, 'departure')) === '{"ok":true,"dueMileage":69600}',
    'the cluster shows a countdown ALWAYS, not only when overdue — the negative is the case that exposed it');
  const noOdo = S.resolveCountdown(-240, null, 'departure');
  check('no reading to count from is refused, not guessed', !noOdo.ok && noOdo.code === 'no_odometer');
  check('  …and reads as the NEXT STEP, naming the right box',
    /Record the mileage out first/.test(noOdo.message)
    && /Record the mileage in first/.test(S.resolveCountdown(-240, null, 'arrival').message),
    'the empty mileage-out box is deliberate, so on Completion this is the ordinary path');
  check('  …and the two stages name DIFFERENT boxes',
    S.resolveCountdown(-240, null, 'arrival').message !== noOdo.message,
    'departure counts from what the car leaves on; sharing a sentence would send a mechanic to the wrong field');
  const daft = S.resolveCountdown(-9000, 500, 'arrival');
  check('a countdown landing before zero is refused', !daft.ok && daft.code === 'before_zero');

  // THE INTERACTION WITH BLANK-VERSUS-CLEARED, which is where these two features could have
  // combined into a deletion: a filled-in countdown row has no dueMileage yet, and a writer that
  // only looked at dueMileage would call it blank — and a blank row is a request to clear.
  const padsItem = S.scheduleByKey('schedule_pads_front');
  check('a countdown row is NOT blank', !S.isBlank(padsItem, { dueMonth: null, dueMileage: null, countdownMiles: -240 }));
  check('  …so it is recorded, never read as an erasure',
    S.classifyEntry(padsItem, { dueMonth: null, dueMileage: null, countdownMiles: -240, wasRecorded: true }) === 'record');
  check('  …while a genuinely empty row still is blank',
    S.isBlank(padsItem, { dueMonth: null, dueMileage: null, countdownMiles: null }));
  // ── A MODE IS NOT A LEG ───────────────────────────────────────────────────────────────────────
  // `mode` says HOW a reading was transcribed, not that there was one. If it ever reaches isBlank's
  // inputs, a row carrying nothing but a mode stops being blank — and a blank row is a request to
  // CLEAR, so the failure is a deletion that silently does not happen. isBlank is the predicate
  // added after five real readings were destroyed; this keeps the new column out of it.
  check('  …and a row carrying ONLY a mode is still blank',
    S.isBlank(padsItem, { dueMonth: null, dueMileage: null, countdownMiles: null, mode: 'countdown' }),
    'a mode is metadata about a reading, never a reading');
  check('  …which is the same answer with no mode at all',
    S.isBlank(padsItem, { dueMonth: null, dueMileage: null, countdownMiles: null })
    === S.isBlank(padsItem, { dueMonth: null, dueMileage: null, countdownMiles: null, mode: 'target' }),
    'adding the column must not move this predicate in either direction');

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
  const site = await zzSite(prisma);
  const owner = await prisma.user.findFirst({ where: { group_id: ZZ, email: 'owner@zzgategarage.test' }, select: { id: true } });
  const cust = await prisma.customer.create({ data: { group_id: ZZ, name: CUST, phone: '07700 900321' }, select: { id: true } });
  const veh = await prisma.vehicle.create({
    data: { group_id: ZZ, registration: 'ZZ76SCH', registration_normalized: 'ZZ76SCH', make: 'Sched', model: 'Fixture',
      mot_expiry: new Date('2026-11-30T00:00:00.000Z') },
    select: { id: true } });
  await prisma.vehicleOwnership.create({ data: { vehicle_id: veh.id, customer_id: cust.id, is_current: true, valid_from: new Date() } });

  // ── THE CARD STARTS WHERE A REAL ONE STARTS ───────────────────────────────────────────────────
  // It used to be created with stage_details_done / stage_intake_done / stage_injob_done already
  // true, and a comment in this file justified it: "it is a state a real card reaches, and the
  // gating has its own gate." Both halves were true and the conclusion was still wrong. spine-gate
  // does prove completion.reachable as a PURE FUNCTION, in both directions — what nothing proved
  // was that a card can be WALKED from creation to Completion through the real APIs, or that the
  // panel waiting on the far side saves anything. The fixture was manufacturing the state it then
  // verified, so the departure panel shipped having never once been driven.
  const card = await prisma.jobCard.create({
    // odometer_in set, because the departure-mileage assertions below are about how the ARRIVAL
    // figure is presented beside the empty box. A card with no arrival mileage shows no context
    // line at all, which is correct and proves nothing about the presentation.
    data: { group_id: ZZ, site_id: site.id, customer_id: cust.id, vehicle_id: veh.id, status: 'quoted', odometer_in: 60000 },
    select: { id: true },
  });
  await prisma.jobCardItem.create({
    data: { job_card_id: card.id, item_type: 'labour', description: 'Schedule fixture work', qty: 1,
      unit_price: 100, vat_rate: 20, vat_amount: 20, labour_hours: 1 } });
  await freezeQuoteVersion({ groupId: ZZ, jobCardId: card.id, vatRegistered: true, taxLabel: 'VAT' });
  await prisma.$transaction(async (tx) => {
    await acceptQuote(tx, { groupId: ZZ, jobCardId: card.id, via: 'counter', actorUserId: owner.id, attested: null, at: new Date() });
  });
  fix = { veh: veh.id, card: card.id, cust: cust.id };

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
  // ── THE STAGES ARE WALKED, NOT SET ────────────────────────────────────────────────────────────
  // Every stage flag on this card is toggled through /api/jobcard-stage, which reads the SAME
  // reachability chokepoint the UI greys with. The card was created at `quoted` with nothing done,
  // so each step must be legal when it is taken — and the sections below run in the order a
  // mechanic works: Details, then Intake (the arrival reading), then In-Job, then Completion (the
  // departure reading). The old fixture set three flags at creation and jumped straight to the
  // end, which is how the departure panel shipped without its save path ever being driven.
  const stage = (st, done = true) => page.evaluate(async (b) => {
    const r = await fetch('/api/jobcard-stage', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin', body: JSON.stringify(b) });
    return { status: r.status, body: await r.json().catch(() => ({})) };
  }, { jobCardId: card.id, stage: st, done });

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
  // The arrival table is the one that lost the five rows, so prove the floor on THAT branch too —
  // the departure branch closes a due item, this one deletes outright.
  const aStale = await post([{ key: 'schedule_oil_service', dueMonth: null, dueMileage: null }], 'arrival');
  const aLeft = await prisma.serviceScheduleReading.count({ where: { job_card_id: card.id, item_key: 'schedule_oil_service' } });
  check('an unclaimed blank does not DELETE an arrival reading either',
    aStale.body.skipped === 1 && aStale.body.cleared === 0 && aLeft === 1,
    JSON.stringify({ ...aStale.body, rowsLeft: aLeft }));
  const aClear = await post([{ key: 'schedule_oil_service', dueMonth: null, dueMileage: null, wasRecorded: true }], 'arrival');
  check('  …and a claimed one still does', aClear.body.cleared === 1,
    'the correction path a garage actually needs is untouched');
  await post([{ key: 'schedule_oil_service', dueMonth: '2026-09', dueMileage: 60000 }], 'arrival');   // put it back

  // ── THE ROUND TRIP: WHAT THE SCREEN SAID, AND WHAT WE CONCLUDED FROM IT ──────────────────────
  // On the ARRIVAL table deliberately: it is never printed, so this cannot disturb the invoice
  // assertions further down.
  const cd = await post([{ key: 'schedule_pads_rear', dueMonth: null, dueMileage: null, countdownMiles: -240 }], 'arrival');
  const cdRow = await prisma.serviceScheduleReading.findFirst({
    where: { job_card_id: card.id, item_key: 'schedule_pads_rear' }, select: { due_mileage: true, countdown_miles: true } });
  check('a countdown save stores BOTH the reading and the conclusion',
    cd.body.written === 1 && cdRow?.countdown_miles === -240 && cdRow?.due_mileage === 59760,
    JSON.stringify({ ...cdRow, odometerIn: 60000 }));
  check('  …and the pair is arithmetic, so the reading it counted from needs no column',
    (cdRow.due_mileage - cdRow.countdown_miles) === 60000,
    'due_mileage minus countdown_miles IS the odometer — recoverable, so not stored twice');
  check('  …with the SERVER deriving it, not the client',
    (await post([{ key: 'schedule_pads_rear', dueMonth: null, dueMileage: 999999, countdownMiles: -240 }], 'arrival')).body.written === 1
    && (await prisma.serviceScheduleReading.findFirst({ where: { job_card_id: card.id, item_key: 'schedule_pads_rear' }, select: { due_mileage: true } }))?.due_mileage === 59760,
    'a client sending both had its target replaced, never merged — the stored pair cannot disagree');

  // ── THE MODE IS THE SERVER'S ACCOUNT OF WHAT IT DID ───────────────────────────────────────────
  // Same rule the pair above already lives under, extended to the third column: a client that says
  // one thing and sends another must not have its claim stored. Read through raw SQL on purpose —
  // before the column exists this reports a NAMED failure instead of throwing on an unknown Prisma
  // field and taking the rest of the run with it.
  //
  // ON schedule_pads_rear THROUGHOUT, and the last write restores the (-240, 59760) pair the block
  // above left. A first draft used schedule_oil_service and broke three downstream checks that read
  // its arrival value — the arrival table is shared fixture state and a mode check has no business
  // moving it.
  const modeOf = async (itemKey) => {
    try {
      const r = await prisma.$queryRawUnsafe(
        'SELECT mode::text AS mode FROM "ServiceScheduleReading" WHERE job_card_id = $1 AND item_key = $2',
        card.id, itemKey);
      return r.length ? (r[0].mode ?? 'NULL') : 'NO ROW';
    } catch (e) { return `NO COLUMN: ${String(e.message).split('\n').filter(Boolean).pop()?.slice(0, 60)}`; }
  };
  check('the countdown save above recorded the mode the SERVER resolved',
    (await modeOf('schedule_pads_rear')) === 'countdown', await modeOf('schedule_pads_rear'));

  const asTarget = await post([{ key: 'schedule_pads_rear', dueMonth: null, dueMileage: 71000, countdownMiles: null }], 'arrival');
  check('  …and a target save records target', asTarget.body.written === 1
    && (await modeOf('schedule_pads_rear')) === 'target', await modeOf('schedule_pads_rear'));

  // THE CONTRADICTION: the client claims one convention and sends the other's payload. The stored
  // mode must describe the PAYLOAD, because that is what produced due_mileage. This also puts the
  // row back to (-240, 59760) for everything downstream.
  const lying = await post([{ key: 'schedule_pads_rear', dueMonth: null, dueMileage: null, countdownMiles: -240, mode: 'target' }], 'arrival');
  check('a client claiming target while sending a countdown is overwritten',
    lying.body.written === 1 && (await modeOf('schedule_pads_rear')) === 'countdown',
    `claimed target, sent a countdown, stored ${await modeOf('schedule_pads_rear')}`);
  const lyingRow = await prisma.serviceScheduleReading.findFirst({
    where: { job_card_id: card.id, item_key: 'schedule_pads_rear' }, select: { due_mileage: true, countdown_miles: true } });
  check('  …and the pair it describes is the one the server derived, unchanged from above',
    lyingRow?.countdown_miles === -240 && lyingRow?.due_mileage === 59760,
    JSON.stringify(lyingRow));

  // ── "NOT YET" IS A DIFFERENT ANSWER FROM "NOT EVER" ──────────────────────────────────────────
  // The departure stage has no odometer_out on this card, which is the ordinary state of a card
  // mid-job and exactly the case a phone can queue against.
  const noRead = await post([{ key: 'schedule_pads_front', dueMonth: null, dueMileage: null, countdownMiles: -100 }], 'departure');
  check('a countdown with no reading to count from is refused', noRead.status === 409, String(noRead.status));
  check('  …with 409 and NOT 400, because 400 is terminal in the outbox', noRead.status === 409
    && /TERMINAL_STATUSES = \[400, 403, 404\]/.test(readFileSync('public/sw.js', 'utf8')),
    'a queued phone save answered 400 is DELETED, not retried — that would destroy a reading a mechanic took');
  check('  …while a countdown landing before zero stays 400',
    (await post([{ key: 'schedule_pads_front', dueMonth: null, dueMileage: null, countdownMiles: -999999 }], 'arrival')).status === 400,
    'retrying a bad payload changes nothing, so it must not sit in the queue forever');

  // LEAVE THE FIXTURE AS IT WAS FOUND. This block added a third arrival row and a later check
  // counts them — an assertion about the departure write must not fail because of a countdown
  // test that ran before it. Cleared through the CLAIMED path, which is a small extra proof that
  // the two features compose.
  await post([{ key: 'schedule_pads_rear', dueMonth: null, dueMileage: null, wasRecorded: true }], 'arrival');
  check('  …and the countdown row clears again, leaving the fixture as it was',
    (await prisma.serviceScheduleReading.count({ where: { job_card_id: card.id } })) === 2);

  check('a card with ONLY an arrival reading prints no schedule line', arrivalOnlyBlock === null,
    'better an absent line than an arrival figure dressed as what is next');

  const r1 = await post([
    { key: 'schedule_oil_service', dueMonth: '2027-03', dueMileage: 60000 },
    { key: 'schedule_pads_front', dueMonth: null, dueMileage: 45000 },
    // BOTH LEGS NOW — a vehicle check is whichever_first, so a month alone would be refused.
    { key: 'schedule_vehicle_check', dueMonth: '2027-08', dueMileage: 90000 },
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
    && items.find((i) => i.observation_key === 'schedule_vehicle_check')?.due_basis === 'whichever_first',
    items.map((i) => `${i.observation_key}:${i.due_basis}`).join(' '));
  check('  …the blank row wrote nothing', !items.some((i) => i.observation_key === 'schedule_brake_fluid'));
  check('  …and the response is not_raised, by design', items.every((i) => i.customer_response === 'not_raised'));

  // ── A BLANK ROW THE FORM NEVER HELD IS NOT AN ERASURE ────────────────────────────────────────
  // The trapdoor under the 21 Aug loss. The seed-once defect that walked into it is fixed; this is
  // the floor, so the next component to go stale finds a writer that declines rather than deletes.
  console.log('\n— blank, versus cleared —');
  const seeded = await post([{ key: 'schedule_pads_rear', dueMonth: null, dueMileage: 61000 }]);
  check('a row is recorded to be erased later', seeded.body.written === 1);
  const stale = await post([{ key: 'schedule_pads_rear', dueMonth: null, dueMileage: null }]);   // no claim
  const survived = await prisma.vehicleDueItem.findFirst({
    where: { vehicle_id: veh.id, observation_key: 'schedule_pads_rear', closed_at: null }, select: { due_mileage: true } });
  check('a blank with NO wasRecorded claim clears nothing',
    stale.body.cleared === 0 && stale.body.skipped === 1 && survived?.due_mileage === 61000,
    JSON.stringify({ ...stale.body, still: survived?.due_mileage }));
  check('  …and the audit says so in a sentence, not a count',
    /did not report holding a reading/.test(JSON.stringify(
      (await prisma.auditLog.findFirst({ where: { entity_id: card.id, action: 'service_schedule.recorded' }, orderBy: { created_at: 'desc' }, select: { diff_json: true } }))?.diff_json ?? {})),
    'a skipped row is a decision the writer took, and has to read as one a year from now');
  const erased = await post([{ key: 'schedule_pads_rear', dueMonth: null, dueMileage: null, wasRecorded: true }]);
  check('  …while the SAME payload with the claim does clear it', erased.body.cleared === 1 && erased.body.skipped === 0,
    JSON.stringify(erased.body));
  check('  …so the difference is the claim, not the values', JSON.stringify(erased.body) !== JSON.stringify(stale.body));

  // wasRecorded:false is not the same request as wasRecorded absent, and both must be safe.
  const explicitFalse = await post([{ key: 'schedule_pads_front', dueMonth: null, dueMileage: null, wasRecorded: false }]);
  check('an explicit wasRecorded:false is also declined', explicitFalse.body.skipped === 1 && explicitFalse.body.cleared === 0);

  // RE-TRANSCRIBING CORRECTS. A schedule is a current state, not a log.
  const r2 = await post([{ key: 'schedule_pads_front', dueMonth: null, dueMileage: 48000 }]);
  const pads = await prisma.vehicleDueItem.findMany({ where: { vehicle_id: veh.id, observation_key: 'schedule_pads_front' } });
  check('re-recording corrects rather than stacks', r2.status === 200 && pads.length === 1 && pads[0].due_mileage === 48000,
    `${pads.length} row(s), ${pads[0]?.due_mileage} miles`);

  // ── EMPTYING A ROW RETRACTS IT — BUT ONLY WHEN A PERSON EMPTIED IT ───────────────────────────
  // `wasRecorded: true` is the form saying "I was handed a reading for this row and it is gone
  // now", which is a retraction. The same payload WITHOUT that claim is a form that never held
  // the row, and the block below proves it is left alone. Both sentences, one writer.
  const r3 = await post([{ key: 'schedule_pads_front', dueMonth: null, dueMileage: null, wasRecorded: true }]);
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
  // INTAKE IS LOCKED UNTIL DETAILS IS DONE, and the server says so before the tab does.
  const intakeTooSoon = await stage('intake');
  check('Intake cannot be completed before Details', intakeTooSoon.status === 409, JSON.stringify(intakeTooSoon));
  check('Details completes, and unlocks it', (await stage('details')).status === 200);
  await page.goto(`${BASE}/admin/jobcards/${card.id}?tab=intake`, { waitUntil: 'domcontentloaded' });
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
  // ── MOVED BEFORE THE MINT, 2026-08-20 ───────────────────────────────────────────────────────
  // This block used to run after the invoice was issued, and passed only because nothing stopped
  // a finished job taking new bay data. lib/bay-write closed that, and the gate went red — which
  // is the guard working: the arrival reading is taken at INTAKE, on a card nobody has billed.
  // The old position was asserting a sequence no mechanic performs.
  // ── 8. THE ARRIVAL READING, IN THE BAY ───────────────────────────────────────────────────────
  // Reading a service computer is a bay job by definition — the screen is in the car — and until
  // now the mechanic standing at it was the one person who could not record what it said.
  console.log('\n— the phone, where the screen actually is —');
  const phone = await (await browser.newContext({ viewport: { width: 390, height: 844 },
    isMobile: true, hasTouch: true, storageState: await page.context().storageState() })).newPage();
  await phone.goto(`${BASE}/m/job/${card.id}`, { waitUntil: 'domcontentloaded' });
  await phone.locator('[data-testid="phone-schedule"]').waitFor({ timeout: 30000 });
  check('the schedule panel is on the phone card', true);
  check('  …opening on what this visit already recorded, not blank',
    (await phone.locator('[data-testid="phone-schedule-month-schedule_oil_service"]').inputValue()) !== '',
    'a capture panel that opens blank over stored values tells a mechanic their work was lost');

  // THE LEGS ARE THE SHARED RULE, not a second copy of it.
  check('a pads row offers miles and no month, here too',
    (await phone.locator('[data-testid="phone-schedule-miles-schedule_pads_front"]').count()) === 1
    && (await phone.locator('[data-testid="phone-schedule-month-schedule_pads_front"]').count()) === 0);
  check('  …and brake fluid the reverse',
    (await phone.locator('[data-testid="phone-schedule-month-schedule_brake_fluid"]').count()) === 1
    && (await phone.locator('[data-testid="phone-schedule-miles-schedule_brake_fluid"]').count()) === 0);
  check('  …and the vehicle check now offers BOTH, as the corrected basis says',
    (await phone.locator('[data-testid="phone-schedule-month-schedule_vehicle_check"]').count()) === 1
    && (await phone.locator('[data-testid="phone-schedule-miles-schedule_vehicle_check"]').count()) === 1,
    'one catalogue, both surfaces — a basis corrected in one place is corrected in both');
  check('the MOT is shown and cannot be typed into',
    (await phone.locator('[data-testid="phone-schedule-mot"]').count()) === 1
    && (await phone.locator('[data-testid="phone-schedule-mot"] input').count()) === 0);

  // ── THE DEPARTURE READING IS NOT REACHABLE FROM HERE, AND THAT IS THE DESIGN ──────────────────
  const phoneSrc = readFileSync('components/pwa/PhoneServiceSchedule.tsx', 'utf8');
  check('the phone panel takes no stage, so it cannot be asked for the departure one',
    !/stage/.test(phoneSrc.split('export default function')[1] ?? ''),
    'the reading that freezes onto an invoice is not taken on the surface with no guard');
  check('  …and the drain fixes stage:arrival too, not just the caller',
    /stage: 'arrival'/.test(readFileSync('public/sw.js', 'utf8')),
    'a queued envelope is replayed by the worker; the caller is not the last word');
  // MATCHED AS AN EMITTED KEY, not as a word. The first version banned the string outright and
  // failed on the comment in that file explaining why the field is withheld — a scan whose search
  // term appears in its own subject, for the third time today.
  check('  …and the PWA payload does not even carry the departure reading',
    !/^\s*serviceSchedule:/m.test(readFileSync('pages/api/pwa/job/[id].ts', 'utf8')),
    'shipping it would be an invitation');

  // ── AND IT REACHES THE DATABASE THROUGH THE QUEUE ────────────────────────────────────────────
  // The save is a durable enqueue, not a request. What is proven here is the whole path: panel →
  // outbox → service worker → /api/service-schedule → ServiceScheduleReading.
  // COUNTED BEFORE AND AFTER. A pads_rear due item already exists on this car — the DESKTOP
  // departure panel wrote one earlier in this run — so "no due item exists" would be false for a
  // reason that has nothing to do with the phone. What must not change is that the phone added one.
  const dueBefore = await prisma.vehicleDueItem.count({ where: { vehicle_id: veh.id } });
  await phone.fill('[data-testid="phone-schedule-miles-schedule_pads_rear"]', '54321');
  await phone.locator('[data-testid="phone-schedule-save"]').click();
  await phone.locator('[data-testid="phone-schedule-queued"]').waitFor({ timeout: 25000 });
  let landed = null;
  for (let i = 0; i < 40; i++) {
    landed = await prisma.serviceScheduleReading.findFirst({
      where: { job_card_id: card.id, item_key: 'schedule_pads_rear' }, select: { due_mileage: true } });
    if (landed?.due_mileage === 54321) break;
    await phone.waitForTimeout(500);
  }
  check('what was typed in the bay reached the database through the queue',
    landed?.due_mileage === 54321, JSON.stringify(landed));
  check('  …as an ARRIVAL reading, adding no due item',
    (await prisma.vehicleDueItem.count({ where: { vehicle_id: veh.id } })) === dueBefore,
    'the phone cannot put a line on a customer’s invoice');
  check('  …and the figure it sent appears in no due item at all',
    (await prisma.vehicleDueItem.count({ where: { vehicle_id: veh.id, due_mileage: 54321 } })) === 0,
    '54321 is unique to this phone save, so its absence is traceable to the phone');
  await phone.context().close();

  console.log('\n— on to Completion, still through the stages —');
  // THE LOCK IS REAL. Completion is not merely un-ticked on a fresh card — it cannot be
  // ticked, and the refusal comes from the server, not from a greyed button.
  const tooSoon = await stage('complete');
  check('Completion cannot be completed before In-Job', tooSoon.status === 409
    && /Complete the previous step/.test(tooSoon.body?.message ?? ''), JSON.stringify(tooSoon));
  await page.goto(`${BASE}/admin/jobcards/${card.id}?tab=completion`, { waitUntil: 'domcontentloaded' });
  check('  …and the panel is not reachable while it is locked',
    (await page.locator('[data-testid="service-schedule"]').count()) === 0,
    'this is the state the fixture used to skip past, and the state a real card sat in all morning');

  check('Intake completes, the arrival reading having been taken', (await stage('intake')).status === 200);
  check('In-Job completes, the quote having been accepted', (await stage('injob')).status === 200);

  await page.goto(`${BASE}/admin/jobcards/${card.id}?tab=completion`, { waitUntil: 'domcontentloaded' });
  // A NAMED CHECK, not a waitForSelector. When the panel is absent — the defect as it was actually
  // reported — a bare wait aborts the run at a timeout and takes the twelve assertions after it
  // down with it. "The panel is not there" is the finding; it should read as one.
  // Anchored on the tab's OWN stage button, which is present whether or not the panel is — so the
  // wait proves the tab rendered and the count below is then a real answer about the panel.
  await page.locator('[data-testid="stage-complete-complete"]').waitFor({ timeout: 25000 });
  const panelHere = (await page.locator('[data-testid="service-schedule"]').count()) === 1;
  check('the schedule panel is on Completion too', panelHere,
    panelHere ? '' : 'THE DEPARTURE READING CANNOT BE TAKEN — every schedule line downstream of this is unreachable');
  if (!panelHere) throw new Error('departure panel absent — remaining assertions would be meaningless');
  check('  …opening on the DEPARTURE reading',
    (await page.locator('[data-testid="schedule-month-schedule_oil_service"]').inputValue()) === '2027-03',
    'what the car needs next — the one the invoice freezes');
  check('  …and showing what the car arrived with, for comparison',
    /on arrival: 60,000 mi/.test(await page.locator('[data-testid="schedule-arrival-schedule_oil_service"]').innerText()),
    'so the mechanic corrects a number rather than recalling one');
  check('the heading says which reading it is',
    /what’s next/.test(await page.locator('[data-testid="service-schedule"] h3').innerText()),
    'two panels, two jobs, and neither should be mistaken for the other');

  // ── THE PANEL ITSELF, TYPED INTO AND SAVED ───────────────────────────────────────────────────
  // Everything above this line reached the database through fetch('/api/service-schedule'). That
  // proved the endpoint and the freeze; it proved NOTHING about whether a mechanic can produce
  // such a write, and the departure panel shipped with its save path never once exercised.
  //
  // The values here are deliberately unlike any written earlier in this run, so what lands in
  // VehicleDueItem is traceable to THIS form submission and not to an earlier API call.
  console.log('\n— typed into the panel, and saved —');
  await page.fill('[data-testid="schedule-month-schedule_oil_service"]', '2028-05');
  await page.fill('[data-testid="schedule-miles-schedule_oil_service"]', '88000');
  await page.fill('[data-testid="schedule-miles-schedule_pads_rear"]', '77000');
  await page.locator('[data-testid="schedule-save"]').click();
  await page.locator('[data-testid="schedule-saved"]').waitFor({ timeout: 25000 });
  check('the panel reports it saved', true, await page.locator('[data-testid="schedule-saved"]').innerText());

  const typed = await prisma.vehicleDueItem.findMany({
    where: { vehicle_id: veh.id, closed_at: null, observation_key: { in: ['schedule_oil_service', 'schedule_pads_rear'] } },
    select: { observation_key: true, due_basis: true, due_date: true, due_mileage: true, found_on_job_card_id: true },
  });
  const oil = typed.find((i) => i.observation_key === 'schedule_oil_service');
  const rear = typed.find((i) => i.observation_key === 'schedule_pads_rear');
  check('what was typed is what is stored', oil?.due_mileage === 88000
    && oil?.due_date?.toISOString().slice(0, 10) === '2028-05-01' && oil?.due_basis === 'whichever_first',
    `${oil?.due_mileage} / ${oil?.due_date?.toISOString().slice(0, 10)} / ${oil?.due_basis}`);
  check('  …on the mileage-only row too', rear?.due_mileage === 77000 && rear?.due_basis === 'mileage',
    `${rear?.due_mileage} / ${rear?.due_basis}`);
  check('  …and the finding is attributed to the card it was taken on',
    oil?.found_on_job_card_id === card.id, oil?.found_on_job_card_id ?? 'null');

  // ── THE FORM SURVIVES A TAB SWITCH ────────────────────────────────────────────────────────────
  // 21 Aug: the owner recorded five items on TMBS D13DSK, changed tab, came back to an empty form
  // and saved it. A blank row means "clear this item", so the save DELETED all five:
  //   09:22:48 arrival written=5 cleared=0   →   09:23:37 arrival written=0 cleared=5
  //
  // THE TAB MUST BE CLICKED, NOT NAVIGATED TO. `?tab=` is a route change: it re-runs SSR and hands
  // the pane fresh props, which is exactly the thing that HIDES this defect — the gate would pass
  // against the broken build. The whole bug is the client-side remount, so the only honest path is
  // the strip button a person presses. This is the counter-example to the shortcut that was
  // reasonable last time: there, the URL was a more honest test; here, it tests nothing.
  console.log('\n— the schedule survives a tab switch —');
  await page.goto(`${BASE}/admin/jobcards/${fix.card}?tab=intake`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-testid="service-schedule"]');
  await page.fill('[data-testid="schedule-month-schedule_brake_fluid"]', '2029-03');
  await page.fill('[data-testid="schedule-miles-schedule_pads_front"]', '52000');
  await page.click('[data-testid="schedule-save"]');
  await page.waitForSelector('[data-testid="schedule-saved"]');

  const tab = async (k) => {
    // SETTLE FIRST. Saving fires onSaved → refreshCard, and when that response lands React
    // re-renders the workspace and DETACHES the tab button mid-click; the retry races the next
    // render and the click times out on an element that was never unclickable. Probed directly:
    // the button is visible, enabled, and hit-tests to its own child. The wait is for the paint,
    // not for the control.
    await page.waitForLoadState('networkidle');
    const b = page.locator(`[data-testid="tab-${k}"]`);
    await b.scrollIntoViewIfNeeded();
    // ── RETRY THE CLICK, DO NOT WEAKEN IT ───────────────────────────────────────────────────────
    // This timed out on some runs and not others. Measured in the failing context, the button is
    // count=1, visible, enabled, stable at a fixed box, and hit-tests to its own child — so it is
    // not obscured, off-screen or disabled, and it is NOT the scroll-snap strip: the box never
    // moves. What it is: the save fires onSaved → refreshCard, and when that lands the workspace
    // re-renders and REPLACES the strip's buttons, so the node Playwright resolved is detached
    // between resolve and click. Adding diagnostics made it pass — their latency is the tell.
    //
    // So: a fresh locator per attempt, each with the full actionability checks. `force: true`
    // would make it pass every time by skipping exactly the checks that make this a real click,
    // which is the difference between proving a mechanic can switch tabs and proving nothing.
    let clicked = false;
    for (let i = 0; i < 5 && !clicked; i++) {
      try { await page.locator(`[data-testid="tab-${k}"]`).click({ timeout: 5000 }); clicked = true; }
      catch { await page.waitForTimeout(300); }
    }
    if (!clicked) throw new Error(`could not click the ${k} tab after 5 attempts`);
    await page.waitForTimeout(400);
  };
  await tab('details');
  check('the pane really did unmount (otherwise this proves nothing)',
    (await page.locator('[data-testid="service-schedule"]').count()) === 0,
    'if Intake stayed mounted, coming back would not re-run the seed and the test would be vacuous');
  await tab('intake');
  await page.waitForSelector('[data-testid="service-schedule"]');

  const back = {
    month: await page.inputValue('[data-testid="schedule-month-schedule_brake_fluid"]'),
    miles: await page.inputValue('[data-testid="schedule-miles-schedule_pads_front"]'),
  };
  check('coming back to Intake, the saved schedule is still in the form',
    back.month === '2029-03' && back.miles === '52000', JSON.stringify(back));

  // The half that cost the readings. An empty form that saves is not a display problem.
  await page.click('[data-testid="schedule-save"]');
  await page.waitForSelector('[data-testid="schedule-saved"]');
  const note = await page.locator('[data-testid="schedule-saved"]').innerText();
  const kept = await prisma.serviceScheduleReading.findMany({
    where: { job_card_id: fix.card }, select: { item_key: true, due_mileage: true, due_month: true } });
  check('  …and saving again CLEARS NOTHING', !/cleared/.test(note), note);
  check('  …with the rows still in the table afterwards',
    kept.some((r) => r.item_key === 'schedule_pads_front' && r.due_mileage === 52000)
    && kept.some((r) => r.item_key === 'schedule_brake_fluid' && r.due_month?.toISOString().slice(0, 7) === '2029-03'),
    `${kept.length} rows: ${kept.map((r) => r.item_key).join(', ')}`);

  // ── THE COUNTDOWN, AT THE CAR ────────────────────────────────────────────────────────────────
  // The screen shows "-240 mi" and the mechanic needs somewhere to put it. Before this, the box
  // stripped the minus and stored 240 — a service due at 240 miles, silently.
  console.log('\n— reading a countdown off the cluster —');
  await page.click('[data-testid="schedule-unit-countdown"]');
  await page.fill('[data-testid="schedule-miles-schedule_pads_rear"]', '-240');
  const working = await page.locator('[data-testid="schedule-working-schedule_pads_rear"]').innerText();
  check('the minus survives being typed', (await page.inputValue('[data-testid="schedule-miles-schedule_pads_rear"]')) === '-240',
    'it used to be stripped by the input, turning -240 into a target of 240');
  check('  …and the form shows what it worked out', /due at 59,760/.test(working) && /already overdue/.test(working), working);
  check('  …counting from the reading it names',
    /60,000/.test(await page.locator('[data-testid="schedule-count-from"]').innerText()));
  await page.click('[data-testid="schedule-save"]');
  await page.waitForSelector('[data-testid="schedule-saved"]');
  const stored = await prisma.serviceScheduleReading.findFirst({
    where: { job_card_id: fix.card, item_key: 'schedule_pads_rear' }, select: { due_mileage: true, countdown_miles: true } });
  check('  …and stores the reading beside the conclusion', stored?.countdown_miles === -240 && stored?.due_mileage === 59760,
    JSON.stringify(stored));

  // Switching back CONVERTS rather than reinterpreting: -240 is 59,760 as a target, not a service
  // 240 miles from nowhere. Getting this wrong would silently multiply every figure on the panel.
  await page.click('[data-testid="schedule-unit-target"]');
  check('switching units converts what is already typed',
    (await page.inputValue('[data-testid="schedule-miles-schedule_pads_rear"]')) === '59760',
    'leaving the digits alone would turn a countdown into a target 60,000 miles out');

  // Leave the fixture as it was found — this row is not part of the invoice assertions below, and
  // a later check counts the arrival rows.
  await page.fill('[data-testid="schedule-miles-schedule_pads_rear"]', '');
  await page.click('[data-testid="schedule-save"]');
  await page.waitForSelector('[data-testid="schedule-saved"]');

  // Put the browser back where the next section inherited it (Completion, loaded at line ~411).
  // Leaving it on Intake broke the mileage-out checks downstream — a section reading a control
  // that only exists on another tab, failing for a reason that had nothing to do with its subject.
  await page.goto(`${BASE}/admin/jobcards/${fix.card}?tab=completion`, { waitUntil: 'domcontentloaded' });

  // ── AND THE INVOICE FREEZES WHAT THE PANEL WROTE ─────────────────────────────────────────────
  // A real mint through the real path, so the snapshot is the one a customer would receive.
  check('Completion completes', (await stage('complete')).status === 200);
  let invId = null;
  await prisma.$transaction(async (tx) => { invId = await issueInvoiceForCard(tx, card.id, ZZ); }, { timeout: 30000 });
  fix.invoice = invId;
  const snap = (await prisma.invoice.findUnique({ where: { id: invId }, select: { due_items_snapshot: true } }))?.due_items_snapshot ?? '';
  check('the invoice froze the line the PANEL produced',
    /Next oil service due at 88,000 miles or by May 2028, whichever comes first/.test(snap), snap.slice(0, 200));
  check('  …and the mileage-only row beside it', /Rear brake pads due at 77,000 miles/.test(snap));
  check('  …with the MOT once, from the car', (snap.match(/MOT Expiry/g) ?? []).length === 1
    && /30 November 2026/.test(snap));
  check('  …and no arrival figure anywhere in it', !/60,000/.test(snap),
    'the arrival reading is a visit measurement and must never reach a customer document');
  // ── 7b. THE DEPARTURE MILEAGE IS A MEASUREMENT, NOT A DEFAULT ────────────────────────────────
  // The box beside this panel used to prefill with the arrival mileage. Saving it unchanged stored
  // arrival-equals-departure, making "I read the dash and it hadn't moved" and "I pressed save
  // without looking" the same row. On TMBS, 24 of the 31 stored departure mileages are that
  // ambiguity and cannot be salvaged (measured 20 Aug 2026).
  console.log('\n— mileage out: empty, with the arrival figure beside it —');
  const O = await import('../lib/odometer.ts');
  check('the box is empty on a card that has no departure reading',
    (await page.locator('[data-testid="mileage-out-input"]').inputValue()) === '',
    'a default indistinguishable from a confirmation, on a field whose only purpose is to be a measurement');
  check('  …and the arrival figure is shown beside it, as context',
    /Came in on/.test(await page.locator('[data-testid="mileage-in-context"]').innerText()),
    'a mechanic comparing against it is doing the thing the field exists for; one accepting it is not');
  check('  …and the source no longer prefills from mileage-in',
    !/props\.mileageIn != null \? String\(props\.mileageIn\)/.test(readFileSync('components/jobcard/JobCardWorkspace.tsx', 'utf8')));

  // THE FALLBACK MOVED TO READ TIME, AND SAYS WHICH IT IS.
  check('a taken reading is reported as measured',
    O.visitEndMileage({ odometerIn: 60000, odometerOut: 60120 }).basis === 'measured');
  check('  …an absent one falls back to arrival AND says it assumed',
    O.visitEndMileage({ odometerIn: 60000, odometerOut: null }).basis === 'assumed_unchanged'
    && O.visitEndMileage({ odometerIn: 60000, odometerOut: null }).miles === 60000,
    'the number a consumer wanted, with the fact that nobody measured it attached');
  check('  …and a car with neither is unknown, not zero',
    O.visitEndMileage({ odometerIn: null, odometerOut: null }).miles === null,
    'honest-null: no reading is not a reading of nothing');
  check('  …and a departure reading EQUAL to arrival still reads as measured',
    O.visitEndMileage({ odometerIn: 60000, odometerOut: 60000 }).basis === 'measured',
    'the whole point of the empty box: equal-to-arrival is now a finding, not an artefact');
  check('the permanent ambiguity is recorded with its date',
    /PERMANENTLY AMBIGUOUS/.test(prose(readFileSync('lib/odometer.ts', 'utf8')))
    && /20 August 2026/.test(prose(readFileSync('lib/odometer.ts', 'utf8')))
    && /UPPER BOUND/.test(prose(readFileSync('lib/odometer.ts', 'utf8'))),
    'rows written before that date inherit the bound; rows after it do not');

} catch (e) {
  check('gate run completed', false, String(e?.message ?? e).slice(0, 300));
  await explainIfClientStale(BASE);
} finally {
  if (browser) await browser.close().catch(() => {});
  if (fix) {
    const step = async (n, f) => { try { await f(); } catch (e) { console.log(`  teardown ${n}: ${String(e?.message ?? e).slice(0, 90)}`); } };
    // THE INVOICE GOES FIRST — an issued invoice blocks a card delete, by design.
    //
    // NOTE, because someone will find it: minting here CONSUMES a number from ZZ's gapless invoice
    // series, and deleting the row afterwards leaves a hole. That is accepted on the gate tenant
    // (scripts/card-fulfilment-gate does the same) and is exactly why fixtures never mint on TMBS.
    if (fix.invoice) {
      await step('invoice lines', () => prisma.invoiceLine.deleteMany({ where: { invoice_id: fix.invoice } }));
      await step('invoice', () => prisma.invoice.deleteMany({ where: { id: fix.invoice } }));
    }
    await step('quote versions', () => prisma.quoteVersion.deleteMany({ where: { job_card_id: fix.card } }));
    await step('card items', () => prisma.jobCardItem.deleteMany({ where: { job_card_id: fix.card } }));
    await step('due items', () => prisma.vehicleDueItem.deleteMany({ where: { vehicle_id: fix.veh } }));
    await step('card', () => prisma.jobCard.deleteMany({ where: { id: fix.card } }));
    await step('readings', () => prisma.serviceScheduleReading.deleteMany({ where: { vehicle_id: fix.veh } }));
    await step('edges', () => prisma.vehicleOwnership.deleteMany({ where: { vehicle_id: fix.veh } }));
    await step('vehicle', () => prisma.vehicle.deleteMany({ where: { id: fix.veh } }));
    await step('customer', () => prisma.customer.deleteMany({ where: { group_id: ZZ, name: CUST } }));
    // BY THE FIXTURE'S OWN REGISTRATION AND NAME, not only by ids the run happens to hold.
    check('teardown removed every fixture row (ZZ only)',
      (await prisma.vehicle.count({ where: { group_id: ZZ, registration: 'ZZ76SCH' } })) === 0
      && (await prisma.customer.count({ where: { group_id: ZZ, name: CUST } })) === 0
      && (await prisma.vehicleDueItem.count({ where: { group_id: ZZ, vehicle_id: fix.veh } })) === 0
      && (await prisma.serviceScheduleReading.count({ where: { group_id: ZZ } })) === 0);
  }
}

console.log(`\n${out.filter((c) => c === 'F').length} failures of ${out.length}`);
await prisma.$disconnect();
process.exit(out.includes('F') ? 1 : 0);
