/**
 * File: scripts/diary-drag-gate.mjs
 * @gate-requires: db, server
 *
 * DRAGGING A BOOKING: the two rules the drag needed that the dialog never had, and the gesture
 * driven for real with a mouse.
 *
 * ── WHY A DRAG NEEDED NEW RULES ─────────────────────────────────────────────────────────────────
 * Moving a card already ran through placeJobCard, so a drag inherits tenant scope, the manager
 * check, the billing gate, the site-hours footprint and the double-booking refusal for free. Two
 * things it did NOT inherit, because a dialog behind a context menu is two deliberate presses and
 * a drag is a thumb-slip:
 *
 *   SLOT_IS_HISTORY   an invoiced, paid, done, cancelled, declined or no-show card has a slot that
 *                     is a RECORD of what happened. Nothing refused moving one.
 *   NOT_WORKING_TIME  computeFootprint ADVANCES a start that is not a working moment, which is
 *                     right for an end and silent relocation for a start: dropped at 20:00 the
 *                     card reappears at 08:00 the next day, moved somewhere nobody pointed at.
 *
 * ── AND THE ONE IT ALREADY HAD, WHICH THE DRAG MUST NOT UNDO ────────────────────────────────────
 * DURATION IS THE SOURCE OF TRUTH. A drag that sent an end time would stretch any job it dragged
 * across a break or past close, because (end − start) counts the time the garage is shut as work.
 *
 * ── THE ACT, NOT THE STATUS ─────────────────────────────────────────────────────────────────────
 * SLOT_IS_HISTORY applies to a MOVE and not to a BOOK, and the distinction is load-bearing: a
 * declined card being reopened and booked still holds the slot data of the booking it lost, and
 * that is exactly what the act replaces. Both directions are asserted against the chokepoint.
 *
 * ── AND DURATION IS THE ONLY THING EITHER DOOR ACCEPTS (2026-10-01) ─────────────────────────────
 * Both routes that reach placeJobCard are covered here, because the rule is about the chokepoint
 * rather than the gesture: /api/diary moves and /api/jobcard creates, and neither takes an end
 * time any more. (end − start) counts a lunch break and the hours the garage is shut as work, so a
 * 09:00–17:00 booking at a site that closes for lunch would be recorded as eight WORKING hours and
 * run to 18:00. The create route used to derive minutes that way with a comment asserting its
 * caller was within-day — a premise about another file that nothing checked.
 *
 * A REFUSAL ALSO NAMES THE DOOR THAT WORKS, from the transition table: a declined card is re-booked
 * through Accept, a cancelled or no-show one by reopening it to a draft, and a finished one not at
 * all — so it says nothing rather than pointing at a button that is not there.
 *
 * Fixtures on ZZ Gate Garage only, prefix ZZDRAG, swept before and after. Never TMBS.
 */
import './_gate-preflight.mjs';
const { gatePrisma, describeError, ZZ_GROUP, zzSite, gateOrigin, serverReady } = await import('./_gate-preflight.mjs');
import './_ts.mjs';
const { chromium } = await import('/Users/hugh/Developer/greasedesk-core/node_modules/playwright-core/index.mjs');
const { readFileSync } = await import('node:fs');

const out = [];
const check = (n, ok, d = '') => { out.push(ok ? 'P' : 'F'); console.log(`${ok ? '✓' : '✗'} ${n}${d ? `  — ${d}` : ''}`); };
const R = '/Users/hugh/Developer/greasedesk-core';
const ST = await import(`${R}/lib/jobcard-status.ts`);
const OC = await import(`${R}/lib/occupancy.ts`);
const DB = await import(`${R}/lib/diary-booking.ts`);
const PREFIX = 'ZZDRAG';
const MIN = 60000;

/** A Monday three weeks out: an open day at ZZ (Mon–Fri) with nothing else booked on it. */
function futureMonday() {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() + ((8 - d.getUTCDay()) % 7 || 7) + 14);
  return d;
}
const DAY0 = futureMonday();
/**
 * THE GESTURE TESTS GET THEIR OWN DAY. Every fixture below is laid out so that no two share a lift
 * and an hour — the first version put four cards on one lift at 09:00 and the refusals it was
 * measuring came from its own fixtures clashing with each other, which reads exactly like the
 * product refusing and is not.
 */
const DAY1 = new Date(DAY0.getTime() + 7 * 86_400_000);
const ymd = (d) => d.toISOString().slice(0, 10);
const at = (hh, mm = 0) => new Date(DAY0.getTime() + (hh * 60 + mm) * MIN);
const at1 = (hh, mm = 0) => new Date(DAY1.getTime() + (hh * 60 + mm) * MIN);

let prisma = null;
let browser = null;
let fix = null;
try {
  prisma = await gatePrisma();
  const site = await zzSite(prisma);
  const hours = await prisma.site.findUnique({ where: { id: site.id }, select: { open_hour: true, close_hour: true, open_days: true, breaks: true } });
  const OPEN = hours.open_hour ?? 8;
  const CLOSE = hours.close_hour ?? 18;
  const DAYS = hours.open_days?.length ? hours.open_days : [1, 2, 3, 4, 5, 6];
  const BREAKS = OC.parseBreaks(hours.breaks);
  check(`premise: ${ymd(DAY0)} is an open day at this site`, DAYS.includes(DAY0.getUTCDay()),
    'the whole fixture day would otherwise have no working minutes and every clause below would be about nothing');

  // ── WHICH SLOTS ARE RECORDS ───────────────────────────────────────────────────────────────────
  console.log('\n— a finished or abandoned slot is a record, not a plan —');
  const WANT_MOVABLE = { draft: true, quoted: true, accepted: true, in_progress: true, invoiced: false, paid: false, done: false, declined: false, cancelled: false, no_show: false };
  for (const s of ST.JOB_STATUSES) {
    check(`${s} ${WANT_MOVABLE[s] ? 'CAN' : 'cannot'} be moved`, ST.canMoveBooking(s) === WANT_MOVABLE[s]);
  }
  check('every status has an answer — the list is total by construction',
    ST.JOB_STATUSES.every((s) => typeof WANT_MOVABLE[s] === 'boolean') && Object.keys(WANT_MOVABLE).length === ST.JOB_STATUSES.length,
    'statusSubset means a new status fails to compile until somebody decides; this says the gate knows them all too');
  check('a car ON THE LIFT can still be moved to another lift', ST.canMoveBooking('in_progress'),
    'it happens physically, so it must happen on the board');
  console.log('\n— and the refusal names the door that works —');
  const WANT_DOOR = { invoiced: null, paid: null, done: null, declined: 'accept', cancelled: 'reopen', no_show: 'reopen' };
  for (const [st, want] of Object.entries(WANT_DOOR)) {
    check(`${st} → ${want ?? 'no door: the work is finished'}`, ST.reBookingDoor(st) === want, String(ST.reBookingDoor(st)));
  }
  check('every status whose slot is a record has an answer here', ST.SLOT_IS_HISTORY.every((st) => st in WANT_DOOR),
    ST.SLOT_IS_HISTORY.join(', '));
  check('a MOVABLE card has no door — there is nothing to reopen',
    ['draft', 'quoted', 'accepted', 'in_progress'].every((st) => ST.reBookingDoor(st) === null));
  check('the premise each door rests on: declined REACHES accepted, cancelled and no_show reach draft',
    ST.nextTransitions('declined').some((tr) => tr.to === 'accepted')
    && ST.nextTransitions('cancelled').some((tr) => tr.to === 'draft')
    && ST.nextTransitions('no_show').some((tr) => tr.to === 'draft'),
    'the door is READ from the table, so this is what makes the sentences true');
  check('  …and a finished status reaches neither', ['invoiced', 'paid', 'done'].every((st) =>
    !ST.nextTransitions(st).some((tr) => tr.to === 'accepted' || tr.to === 'draft')));

  check('THE INVARIANT: a status that frees its slot cannot be moved — there is no plan left, only a record',
    ST.FREES_THE_SLOT.every((s) => ST.SLOT_IS_HISTORY.includes(s)),
    `${ST.FREES_THE_SLOT.join(', ')} ⊆ ${ST.SLOT_IS_HISTORY.join(', ')}`);
  const statusSrc = readFileSync(`${R}/lib/jobcard-status.ts`, 'utf8');
  // EXACT TEXT, not the identifier: a bare /MOVABLE_RECORD/ would be true of the word anywhere in
  // the file, including the comment that explains it (gate-hygiene's rule F, which caught this).
  // What must exist is the THROW, inside a loop over the other list.
  check('  …and it fails AT BOOT rather than at the first card that moves when it should not',
    statusSrc.includes('for (const s of FREES_THE_SLOT) {')
    && statusSrc.includes('throw new Error(`MOVABLE_RECORD: status \'${s}\' frees its slot but is still movable.'),
    'the pair is checked at module load, where a wrong answer cannot ship');
  const diarySrc = readFileSync(`${R}/pages/admin/diary.tsx`, 'utf8');
  const diaryCode = diarySrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  check('the BOARD asks the same predicate the server refuses with — no second list',
    /canMoveBooking\(c\.status\)/.test(diaryCode) && !/'invoiced'|"invoiced"/.test(diaryCode),
    'a card whose slot is a record must not start the gesture at all');

  // ── A DROP OUTSIDE WORKING TIME ───────────────────────────────────────────────────────────────
  console.log('\n— a drop the garage is closed for is refused, not nudged —');
  const open = (hh, mm = 0) => OC.isWorkingMoment(at(hh, mm).toISOString(), OPEN, CLOSE, DAYS, BREAKS);
  check('inside opening hours is a working moment', open(OPEN + 1) === true);
  check('an hour before opening is not', open(OPEN - 1) === false);
  check('after close is not', open(CLOSE + 1) === false);
  check('the closing hour itself is not — the interval is half-open', open(CLOSE) === false);
  const sunday = new Date(DAY0.getTime() - DAY0.getUTCDay() * 86_400_000);
  check('a closed day is not, whatever the hour',
    OC.isWorkingMoment(new Date(sunday.getTime() + (OPEN + 2) * 3600_000).toISOString(), OPEN, CLOSE, DAYS, BREAKS) === false,
    `tested on ${ymd(sunday)} (day ${sunday.getUTCDay()}), with open days ${DAYS.join(',')}`);
  check('a break band is not, either',
    OC.isWorkingMoment(at(13, 15).toISOString(), OPEN, CLOSE, DAYS, [{ start: 13 * 60, end: 14 * 60 }]) === false);
  // THE HAZARD IS REAL, not hypothetical: this is what the footprint does with the same start.
  const nudged = OC.computeFootprint(at(CLOSE + 2).toISOString(), 120, OPEN, CLOSE, DAYS, BREAKS);
  check('and the refusal is NEEDED: the footprint would have moved that start to another day',
    nudged.segments[0].startISO.slice(0, 10) !== ymd(DAY0),
    `${at(CLOSE + 2).toISOString()} → ${nudged.segments[0].startISO}`);
  // DURATION vs END TIME, as a pure fact about a job that crosses a break.
  const across = OC.computeFootprint(at(12, 30).toISOString(), 120, OPEN, CLOSE, DAYS, [{ start: 13 * 60, end: 14 * 60 }]);
  const spanMin = (Date.parse(across.endISO) - Date.parse(at(12, 30).toISOString())) / MIN;
  check('duration is NOT the span: 2 working hours across a lunch break ends 3 hours later',
    spanMin === 180 && across.segments.length === 2,
    `span ${spanMin} min in ${across.segments.length} segments — an end time sent instead of a duration would book 3 hours of work`);

  // ── THE ACT: THE SAME CARD, TWO ANSWERS ───────────────────────────────────────────────────────
  console.log('\n— fixtures on ZZ: the act decides, not the status alone —');
  const sweep = async () => {
    const cards = await prisma.jobCard.findMany({ where: { group_id: ZZ_GROUP, vehicle: { registration: { startsWith: PREFIX } } }, select: { id: true } });
    await prisma.jobCard.deleteMany({ where: { id: { in: cards.map((c) => c.id) } } });
    await prisma.vehicle.deleteMany({ where: { group_id: ZZ_GROUP, registration: { startsWith: PREFIX } } });
    await prisma.customer.deleteMany({ where: { group_id: ZZ_GROUP, name: { startsWith: PREFIX } } });
    await prisma.resource.deleteMany({ where: { site_id: site.id, name: { startsWith: PREFIX } } });
  };
  await sweep();
  const cust = await prisma.customer.create({ data: { group_id: ZZ_GROUP, site_id: site.id, name: `${PREFIX} Fixture` }, select: { id: true } });
  const lift1 = await prisma.resource.findFirst({ where: { site_id: site.id }, orderBy: { created_at: 'asc' }, select: { id: true, name: true } });
  const lift2 = await prisma.resource.create({ data: { site_id: site.id, name: `${PREFIX} Lift 2`, type: 'lift' }, select: { id: true, name: true } });
  // A THIRD LIFT, KEPT EMPTY on the fixture day: every move below targets it, so a refusal can
  // only come from the rule being tested and never from another fixture sitting in the way.
  const lift3 = await prisma.resource.create({ data: { site_id: site.id, name: `${PREFIX} Lift 3`, type: 'lift' }, select: { id: true, name: true } });
  fix = { custId: cust.id, lifts: [lift2.id, lift3.id], vehIds: [], cardIds: [] };
  const mkCard = async (n, status, start, mins, resourceId) => {
    const veh = await prisma.vehicle.create({ data: { group_id: ZZ_GROUP, registration: `${PREFIX}${n}`, registration_normalized: `${PREFIX}${n}` }, select: { id: true } });
    fix.vehIds.push(veh.id);
    const fp = OC.computeFootprint(start.toISOString(), mins, OPEN, CLOSE, DAYS, BREAKS);
    const card = await prisma.jobCard.create({
      data: {
        group_id: ZZ_GROUP, site_id: site.id, customer_id: cust.id, vehicle_id: veh.id, status,
        resource_id: resourceId, start_at: start, end_at: new Date(Date.parse(fp.endISO)), booking_duration_minutes: mins,
      },
      select: { id: true },
    });
    fix.cardIds.push(card.id);
    return card.id;
  };

  // THE LAYOUT, one line per card: nothing shares a lift and an hour, and lift3 stays empty.
  const liveCard = await mkCard('LIVE', 'accepted', at(8), 60, lift1.id);
  const invCard = await mkCard('INV', 'invoiced', at(10), 60, lift1.id);
  const nsCard = await mkCard('NS', 'no_show', at(12), 60, lift1.id);
  const mover = await mkCard('MOVE', 'accepted', at(14), 120, lift1.id);
  const declined = await mkCard('DECL', 'declined', at(8), 60, lift2.id);
  const imported = await mkCard('IMP', 'accepted', at(10), 60, lift2.id);
  const wrapper = await mkCard('WRAP', 'accepted', at(12), 60, lift2.id);

  const place = (cardId, opts) => prisma.$transaction((tx) => DB.placeJobCard(tx, {
    jobCardId: cardId, resourceId: lift3.id, start: at(11), workingMinutes: 60, siteIds: [site.id], ...opts,
  }));
  let refusal = null;
  await place(declined, { act: 'move' }).catch((e) => { refusal = e.message; });
  check('MOVING a declined card is refused, and the refusal NAMES the status', refusal === 'SLOT_IS_HISTORY:declined', String(refusal));
  const booked = await place(declined, { act: 'book' });
  check('BOOKING the same card, in the same state, is allowed — the reopen path',
    booked?.to?.resourceId === lift3.id, JSON.stringify(booked?.to));
  check('  …and it reports where the booking CAME FROM, for the audit row and the undo',
    booked?.from?.resourceId === lift2.id && booked.from.startAt === at(8).toISOString() && booked.from.workingMinutes === 60,
    JSON.stringify(booked?.from));
  let ntRefusal = null;
  await prisma.$transaction((tx) => DB.placeJobCard(tx, { jobCardId: liveCard, resourceId: lift3.id, start: at(CLOSE + 2), workingMinutes: 60, siteIds: [site.id], act: 'move' }))
    .catch((e) => { ntRefusal = e.message; });
  check('a move to a time the garage is shut is refused', ntRefusal === 'NOT_WORKING_TIME', String(ntRefusal));
  const stillThere = await prisma.jobCard.findUnique({ where: { id: liveCard }, select: { resource_id: true, start_at: true } });
  check('  …and NOTHING was written — not relocated to the next open morning',
    stillThere.resource_id === lift1.id && stillThere.start_at.getTime() === at(8).getTime(),
    `${stillThere.resource_id === lift1.id ? 'lift1' : 'MOVED'} ${stillThere.start_at.toISOString()}`);
  // The same start, as a BOOK, is allowed: an imported card's backdated slot may sit outside today's
  // hours. It stays on lift2, whose next open morning is empty — lift3 is where WRAP is going.
  const outside = await prisma.$transaction((tx) => DB.placeJobCard(tx, { jobCardId: imported, resourceId: lift2.id, start: at(CLOSE + 2), workingMinutes: 60, siteIds: [site.id], act: 'book' })).catch((e) => e.message);
  check('the same out-of-hours start as a BOOK is allowed — an imported day is not a drag',
    typeof outside === 'object' && outside?.to?.resourceId === lift2.id, JSON.stringify(outside));

  // ── THROUGH THE REAL ENDPOINT ─────────────────────────────────────────────────────────────────
  console.log('\n— through PATCH /api/diary, with a real session —');
  const ready = await serverReady();
  check('the dev server serves pages before we drive it', ready.ok, `HTTP ${ready.status}`);
  const origin = gateOrigin();
  browser = await chromium.launch({ channel: 'chrome' });
  const ctx = await browser.newContext({ viewport: { width: 1500, height: 1000 } });
  const pg = await ctx.newPage();
  await pg.goto(`${origin}/admin/login`, { waitUntil: 'domcontentloaded' });
  await pg.fill('input[type="email"]', 'owner@zzgategarage.test');
  await pg.fill('input[type="password"]', 'GateGarage!2026');
  await Promise.all([pg.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 60000 }), pg.click('button[type="submit"]')]);
  const api = (body) => pg.evaluate(async (b) => {
    const r = await fetch('/api/diary', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin', body: JSON.stringify(b) });
    return { status: r.status, body: await r.json().catch(() => ({})) };
  }, body);

  const moved = await api({ jobCardId: mover, resourceId: lift3.id, startAt: at(15).toISOString(), workingMinutes: 120 });
  check('a move lands', moved.status === 200, `${moved.status} ${JSON.stringify(moved.body)}`);
  const movedRow = await prisma.jobCard.findUnique({ where: { id: mover }, select: { resource_id: true, start_at: true, booking_duration_minutes: true } });
  check('  …on the new lift, at the new time, with its length untouched',
    movedRow.resource_id === lift3.id && movedRow.start_at.getTime() === at(15).getTime() && movedRow.booking_duration_minutes === 120,
    JSON.stringify(movedRow));
  const audit = await prisma.auditLog.findFirst({ where: { group_id: ZZ_GROUP, entity_id: mover, action: 'booking.moved' }, orderBy: { created_at: 'desc' }, select: { diff_json: true } });
  check('the audit row carries BOTH positions — where it was and where it went',
    audit?.diff_json?.from?.resourceId === lift1.id && audit.diff_json.from.startAt === at(14).toISOString()
    && audit.diff_json.to.resourceId === lift3.id && audit.diff_json.to.startAt === at(15).toISOString(),
    JSON.stringify(audit?.diff_json));
  check('  …and the response hands the old position back, so an undo is possible at all',
    moved.body?.from?.resourceId === lift1.id && moved.body.from.workingMinutes === 120, JSON.stringify(moved.body?.from));

  // UNDO IS A SECOND MOVE: its own request, its own refusals, its own audit row.
  const undone = await api({ jobCardId: mover, resourceId: moved.body.from.resourceId, startAt: moved.body.from.startAt, workingMinutes: moved.body.from.workingMinutes });
  const backRow = await prisma.jobCard.findUnique({ where: { id: mover }, select: { resource_id: true, start_at: true } });
  check('undo puts it back', undone.status === 200 && backRow.resource_id === lift1.id && backRow.start_at.getTime() === at(14).getTime(),
    `${undone.status} ${JSON.stringify(backRow)}`);
  const rows = await prisma.auditLog.count({ where: { group_id: ZZ_GROUP, entity_id: mover, action: 'booking.moved' } });
  check('  …as a SECOND audit row, never an erasure of the first', rows === 2, `${rows} booking.moved rows`);

  // DURATION, NOT THE SPAN: a 4-hour job dropped at 16:00 wraps past close and keeps its 240.
  const wrapped = await api({ jobCardId: wrapper, resourceId: lift3.id, startAt: at(CLOSE - 2).toISOString(), workingMinutes: 240 });
  const wrapRow = await prisma.jobCard.findUnique({ where: { id: wrapper }, select: { start_at: true, end_at: true, booking_duration_minutes: true } });
  const span = (wrapRow.end_at.getTime() - wrapRow.start_at.getTime()) / MIN;
  check('a job dropped two hours before close keeps its four WORKING hours', wrapped.status === 200 && wrapRow.booking_duration_minutes === 240, `${wrapped.status} ${wrapRow.booking_duration_minutes}`);
  check('  …and the span is longer than the duration, which is why an end time cannot be sent', span > 240, `span ${span} min vs 240 working`);
  const dragCode = diaryCode.slice(diaryCode.indexOf('async function patchBooking'), diaryCode.indexOf('async function undoMove'));
  check('the drag sends workingMinutes and no endAt', /workingMinutes/.test(dragCode) && !/endAt/.test(dragCode), dragCode.slice(0, 0));

  // THE REFUSALS, through the endpoint, with nothing changed.
  for (const [id, status, hour] of [[invCard, 'invoiced', 10], [nsCard, 'no_show', 12]]) {
    const res = await api({ jobCardId: id, resourceId: lift3.id, startAt: at(13).toISOString(), workingMinutes: 60 });
    const row = await prisma.jobCard.findUnique({ where: { id }, select: { resource_id: true, start_at: true } });
    check(`${status} is refused 409 SLOT_IS_HISTORY, and says why`,
      res.status === 409 && res.body?.code === 'SLOT_IS_HISTORY' && /record of what happened/.test(res.body?.message ?? ''),
      `${res.status} ${JSON.stringify(res.body)}`);
    check(`  …and the ${status} card did not move`, row.resource_id === lift1.id && row.start_at.getTime() === at(hour).getTime(),
      row.start_at.toISOString());
  }
  // THE DOOR, THROUGH THE ENDPOINT. The declined fixture is still declined (it was BOOKED above,
  // which is the act that is allowed) so it refuses a MOVE and must say which door works.
  const declRes = await api({ jobCardId: declined, resourceId: lift3.id, startAt: at(13).toISOString(), workingMinutes: 60 });
  check('a declined card refuses the move and points at ACCEPT',
    declRes.status === 409 && declRes.body?.door === 'accept' && /Accept it to re-book the car\./.test(declRes.body?.message ?? ''),
    `${declRes.status} ${JSON.stringify(declRes.body)}`);
  const invDoor = await api({ jobCardId: invCard, resourceId: lift3.id, startAt: at(13).toISOString(), workingMinutes: 60 });
  check('  …and a finished one names NO door rather than inventing one',
    invDoor.body?.door === null && !/Accept|Reopen/.test(invDoor.body?.message ?? ''),
    JSON.stringify(invDoor.body));

  // AN END TIME IS NO LONGER ACCEPTED, and the refusal says what to send instead.
  const endOnly = await pg.evaluate(async (b) => {
    const r = await fetch('/api/diary', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin', body: JSON.stringify(b) });
    return { status: r.status, body: await r.json().catch(() => ({})) };
  }, { jobCardId: liveCard, resourceId: lift3.id, startAt: at(13).toISOString(), endAt: at(15).toISOString() });
  const unmoved = await prisma.jobCard.findUnique({ where: { id: liveCard }, select: { resource_id: true, start_at: true } });
  check('an end time with no duration is refused, and the words say to send a duration',
    endOnly.status === 400 && /an end time cannot say how long a job is/.test(endOnly.body?.message ?? ''),
    `${endOnly.status} ${JSON.stringify(endOnly.body)}`);
  check('  …and nothing was placed from it', unmoved.resource_id === lift1.id && unmoved.start_at.getTime() === at(8).getTime());

  // NO BOOKING MAY OUTRUN THE CLASH PREFILTER. The bound is read from the constant it protects.
  const tooLong = Math.round(DB.PREFILTER_LOOKBACK_MS / 60000) + 24 * 60;
  const spanRes = await api({ jobCardId: liveCard, resourceId: lift3.id, startAt: at(9).toISOString(), workingMinutes: tooLong });
  check(`a booking longer than the prefilter looks back (${Math.round(DB.PREFILTER_LOOKBACK_MS / 86_400_000)} days) is refused`,
    spanRes.status === 400 && spanRes.body?.code === 'SPAN_TOO_LONG', `${spanRes.status} ${JSON.stringify(spanRes.body)}`);
  check('  …because a clash beyond that window is invisible to the guard, not absent',
    /double-booking check cannot see past/.test(spanRes.body?.message ?? ''), spanRes.body?.message ?? '');

  const closedRes = await api({ jobCardId: liveCard, resourceId: lift3.id, startAt: at(CLOSE + 2).toISOString(), workingMinutes: 60 });
  check('a drop out of hours is refused 400, in words that say it will not be nudged',
    closedRes.status === 400 && closedRes.body?.code === 'NOT_WORKING_TIME' && /not be nudged/.test(closedRes.body?.message ?? ''),
    `${closedRes.status} ${JSON.stringify(closedRes.body)}`);

  // A CLASH: lift2 is occupied at 14:00 by MOVE's... no — put a blocker there and drag onto it.
  const blocker = await mkCard('BLOCK', 'accepted', at(9), 120, lift3.id);
  const clashRes = await api({ jobCardId: liveCard, resourceId: lift3.id, startAt: at(9, 30).toISOString(), workingMinutes: 60 });
  const clashRow = await prisma.jobCard.findUnique({ where: { id: liveCard }, select: { resource_id: true, start_at: true } });
  check('dropping onto an occupied lift is refused 409 CLASH', clashRes.status === 409 && clashRes.body?.code === 'CLASH', `${clashRes.status} ${JSON.stringify(clashRes.body)}`);
  check('  …and the card stays exactly where it was — there is nothing to snap back',
    clashRow.resource_id === lift1.id && clashRow.start_at.getTime() === at(8).getTime(), JSON.stringify(clashRow));

  // ── THE OTHER DOOR: CREATE-AND-PLACE ─────────────────────────────────────────────────────────
  console.log('\n— the create route takes a duration too —');
  const createCard = (body) => pg.evaluate(async (b) => {
    const r = await fetch('/api/jobcard', { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin', body: JSON.stringify(b) });
    return { status: r.status, body: await r.json().catch(() => ({})) };
  }, body);
  const cardsBefore = await prisma.jobCard.count({ where: { group_id: ZZ_GROUP, vehicle: { registration: { startsWith: PREFIX } } } });
  const made = await createCard({
    siteId: site.id, registration: `${PREFIX}NEW`, customerName: `${PREFIX} Fixture`,
    // 13:00 on lift3: free. WRAP was moved to 16:00 earlier in this run and BLOCK still holds
    // 09:00–11:00 — the fixture grid again, read before choosing a slot.
    resourceId: lift3.id, startAt: at(13).toISOString(), workingMinutes: 90,
  });
  check('a card created WITH a booking lands', made.status === 200 || made.status === 201, `${made.status} ${JSON.stringify(made.body).slice(0, 160)}`);
  const newCard = await prisma.jobCard.findFirst({
    where: { group_id: ZZ_GROUP, vehicle: { registration: `${PREFIX}NEW` } },
    select: { id: true, booking_duration_minutes: true, start_at: true, resource_id: true, vehicle_id: true },
  });
  if (newCard) { fix.cardIds.push(newCard.id); fix.vehIds.push(newCard.vehicle_id); }
  check('  …with the duration IT WAS GIVEN, not one derived from an end time',
    newCard?.booking_duration_minutes === 90 && newCard?.start_at?.getTime() === at(13).getTime() && newCard?.resource_id === lift3.id,
    JSON.stringify(newCard));
  // A HALF-GIVEN BOOKING IS REFUSED, AND NO CARD IS LEFT BEHIND. It used to fall through and create
  // the card unscheduled: the card exists, the booking does not, and nothing says so.
  const half = await createCard({
    siteId: site.id, registration: `${PREFIX}HALF`, customerName: `${PREFIX} Fixture`,
    // 15:00, also free: with the refusal removed this must fail by CREATING an unscheduled card,
    // not by colliding with another fixture.
    resourceId: lift3.id, startAt: at(15).toISOString(),
  });
  const cardsAfter = await prisma.jobCard.count({ where: { group_id: ZZ_GROUP, vehicle: { registration: { startsWith: PREFIX } } } });
  check('a lift and a time with no duration is REFUSED', half.status === 400 && /needs a lift, a start time and a duration/.test(half.body?.message ?? ''),
    `${half.status} ${JSON.stringify(half.body).slice(0, 140)}`);
  check('  …and no card was created unscheduled behind the refusal', cardsAfter === cardsBefore + 1,
    `${cardsBefore} before, ${cardsAfter} after — one new card, from the booking that WAS complete`);

  // ── THE GESTURE, WITH A REAL MOUSE ───────────────────────────────────────────────────────────
  // ON ITS OWN DAY, a week later, holding exactly two cards: the one being dragged and a ghost.
  // Every other fixture is on DAY0, so a refusal here can only come from the gesture.
  console.log('\n— the gesture —');
  await prisma.jobCard.delete({ where: { id: blocker } });
  fix.cardIds = fix.cardIds.filter((c) => c !== blocker);
  const dragCard = await mkCard('GEST', 'accepted', at1(9), 120, lift1.id);
  const ghostCard = await mkCard('GHOST', 'no_show', at1(13), 120, lift1.id);
  const diaryUrl = `${origin}/admin/diary?site=${site.id}&view=day&date=${ymd(DAY1)}`;
  await pg.goto(diaryUrl, { waitUntil: 'domcontentloaded' });
  await pg.waitForSelector(`[data-reg="${PREFIX}GEST"]`, { timeout: 30000 });
  const geom = await pg.evaluate((p) => {
    const cols = [...document.querySelectorAll('[data-diary-col]')].map((el) => {
      const r = el.getBoundingClientRect();
      return { resource: el.getAttribute('data-col-resource'), date: el.getAttribute('data-col-date'), left: r.left, width: r.width, top: r.top };
    });
    const b = document.querySelector(`[data-reg="${p}GEST"]`)?.getBoundingClientRect();
    return {
      cols, block: b ? { x: b.left + b.width / 2, y: b.top + 10 } : null,
      movable: document.querySelector(`[data-reg="${p}GEST"]`)?.getAttribute('data-movable'),
      ghostMovable: document.querySelector(`[data-reg="${p}GHOST"]`)?.getAttribute('data-movable'),
      hint: document.body.textContent.includes('Drag a booking to move it'),
    };
  }, PREFIX);
  check('the booking is marked movable and the ghost is not', geom.movable === '1' && geom.ghostMovable === '0',
    `card ${geom.movable} / ghost ${geom.ghostMovable}`);
  check('and the diary says the gesture exists', geom.hint);
  const colOf = (id) => geom.cols.find((c) => c.resource === id);
  const col3 = colOf(lift3.id);
  check('all three lifts are on screen as droppable columns', !!col3 && geom.cols.length >= 3, JSON.stringify(geom.cols.map((c) => c.resource)));
  // 15:00. PX_PER_MIN is 1 and a column body starts at midnight, so y = top + minutes.
  const dropX = col3.left + col3.width / 2;
  const dropY = col3.top + 15 * 60;
  await pg.mouse.move(geom.block.x, geom.block.y);
  await pg.mouse.down();
  await pg.mouse.move(dropX, dropY, { steps: 12 });
  const mid = await pg.evaluate(() => {
    const p = document.querySelector('[data-testid="drop-preview"]');
    return { shown: !!p, at: p?.getAttribute('data-at') ?? null, text: p?.textContent ?? null };
  });
  check('a preview appears at the target WHILE dragging, with the new time', mid.shown && mid.at === '15:00', JSON.stringify(mid));
  const beforeDrop = await prisma.jobCard.findUnique({ where: { id: dragCard }, select: { resource_id: true } });
  check('  …and nothing has been written yet — the card has not moved, so a refusal has nothing to undo',
    beforeDrop.resource_id === lift1.id);
  await pg.mouse.up();
  await pg.waitForFunction(() => !!document.querySelector('[data-testid="move-result"]'), null, { timeout: 20000 }).catch(() => {});
  const result = await pg.evaluate(() => ({
    ok: document.querySelector('[data-testid="move-result"]')?.getAttribute('data-ok'),
    text: document.querySelector('[data-testid="move-result"]')?.textContent ?? null,
    undo: !!document.querySelector('[data-testid="move-undo"]'),
  }));
  const after = await prisma.jobCard.findUnique({ where: { id: dragCard }, select: { resource_id: true, start_at: true, booking_duration_minutes: true } });
  check('the drop moved the card to the lift and time it was dropped on',
    after.resource_id === lift3.id && after.start_at.getTime() === at1(15).getTime() && after.booking_duration_minutes === 120,
    JSON.stringify(after));
  check('  …and the board says so, with an Undo', result.ok === '1' && result.undo && /moved to/.test(result.text ?? ''), JSON.stringify(result));

  // A REFUSED DROP: onto the ghost's own lift at its own time is free (a no-show frees the slot),
  // so the refusal to measure is the one the garage meets — a drop where the garage is CLOSED.
  await pg.goto(diaryUrl, { waitUntil: 'domcontentloaded' });
  await pg.waitForSelector(`[data-reg="${PREFIX}GEST"]`, { timeout: 30000 });
  const g2 = await pg.evaluate((p) => {
    const b = document.querySelector(`[data-reg="${p}GEST"]`)?.getBoundingClientRect();
    const el = document.querySelector('[data-diary-col]').getBoundingClientRect();
    return { block: b ? { x: b.left + b.width / 2, y: b.top + 10 } : null, col1: { left: el.left, width: el.width, top: el.top } };
  }, PREFIX);
  await pg.mouse.move(g2.block.x, g2.block.y);
  await pg.mouse.down();
  // HALF AN HOUR BEFORE OPENING, not after close: the scroller starts an hour before opening and
  // shows about twelve hours, so an evening y-coordinate is outside the visible area and the drag
  // lands on nothing at all — which is a gate that tests the viewport, not the rule.
  await pg.mouse.move(g2.col1.left + g2.col1.width / 2, g2.col1.top + (OPEN - 1) * 60 + 30, { steps: 10 });
  const shut = await pg.evaluate(() => ({
    closed: !!document.querySelector('[data-testid="drop-preview-closed"]'),
    normal: !!document.querySelector('[data-testid="drop-preview"]'),
    words: document.querySelector('[data-testid="drop-preview-closed"]')?.textContent ?? null,
  }));
  await pg.mouse.up();
  const shutRow = await prisma.jobCard.findUnique({ where: { id: dragCard }, select: { start_at: true } });
  check('dragging to a time the garage is shut shows a REFUSAL, not a nudged position',
    shut.closed && !shut.normal && /closed/.test(shut.words ?? ''), JSON.stringify(shut));
  check('  …and dropping it there changes nothing', shutRow.start_at.getTime() === at1(15).getTime(), shutRow.start_at.toISOString());

  // THE GHOST: the same gesture, and nothing happens.
  const ghostBox = await pg.evaluate((p) => { const b = document.querySelector(`[data-reg="${p}GHOST"]`)?.getBoundingClientRect(); return b ? { x: b.left + b.width / 2, y: b.top + 10 } : null; }, PREFIX);
  if (ghostBox) {
    await pg.mouse.move(ghostBox.x, ghostBox.y);
    await pg.mouse.down();
    await pg.mouse.move(dropX, col3.top + 16 * 60, { steps: 10 });
    const ghostPreview = await pg.evaluate(() => !!document.querySelector('[data-testid="drop-preview"]'));
    await pg.mouse.up();
    const ghostRow = await prisma.jobCard.findUnique({ where: { id: ghostCard }, select: { resource_id: true, start_at: true } });
    check('dragging a GHOST does nothing at all — no preview, no request, no move',
      !ghostPreview && ghostRow.resource_id === lift1.id && ghostRow.start_at.getTime() === at1(13).getTime(),
      `preview ${ghostPreview} / ${ghostRow.start_at.toISOString()}`);
  } else {
    check('the ghost is on the board to be tested', false, 'ZZDRAGGHOST did not render');
  }

  // ── THE TOUCH PATH, exercised as it is reached: the menu arms the card, the next tap drops it.
  await pg.goto(diaryUrl, { waitUntil: 'domcontentloaded' });
  await pg.waitForSelector(`[data-reg="${PREFIX}GEST"]`, { timeout: 30000 });
  await pg.click(`[data-reg="${PREFIX}GEST"]`, { button: 'right' });
  await pg.waitForSelector('[data-testid="menu-pick-up"]', { timeout: 10000 });
  await pg.click('[data-testid="menu-pick-up"]');
  const armed = await pg.evaluate(() => document.querySelector('[data-testid="drag-armed"]')?.textContent ?? null);
  check('the long-press menu offers a PICK UP, and says the diary has not changed yet',
    /has not changed yet/.test(armed ?? ''), armed ?? 'NOT SHOWN');
  check('  …and a ghost is never offered it', await pg.evaluate(async (p) => {
    const g = document.querySelector(`[data-reg="${p}GHOST"]`);
    g.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 300, clientY: 300 }));
    await new Promise((r) => setTimeout(r, 150));
    return !document.querySelector('[data-testid="menu-pick-up"]');
  }, PREFIX), 'the ghost suppresses the menu entirely');
  await pg.goto(diaryUrl, { waitUntil: 'domcontentloaded' });
  await pg.waitForSelector(`[data-reg="${PREFIX}GEST"]`, { timeout: 30000 });
  await pg.click(`[data-reg="${PREFIX}GEST"]`, { button: 'right' });
  await pg.waitForSelector('[data-testid="menu-pick-up"]', { timeout: 10000 });
  await pg.click('[data-testid="menu-pick-up"]');
  const col2b = await pg.evaluate((id) => { const el = document.querySelector(`[data-col-resource="${id}"]`).getBoundingClientRect(); return { left: el.left, width: el.width, top: el.top }; }, lift2.id);
  await pg.mouse.click(col2b.left + col2b.width / 2, col2b.top + 10 * 60);
  await pg.waitForFunction(() => document.querySelector('[data-testid="move-result"]')?.getAttribute('data-ok') === '1', null, { timeout: 20000 }).catch(() => {});
  const tapped = await prisma.jobCard.findUnique({ where: { id: dragCard }, select: { resource_id: true, start_at: true } });
  check('ONE TAP on the diary drops it there — the finger was never captured, so the scroll still works',
    tapped.resource_id === lift2.id && tapped.start_at.getTime() === at1(10).getTime(),
    `${tapped.start_at.toISOString()} on ${tapped.resource_id === lift2.id ? 'lift2' : 'elsewhere'}`);

  // ── AND THE THING THE DRAG SITS ON TOP OF ────────────────────────────────────────────────────
  // A CLICK OPENS THE CARD. This gate proved the drag in forensic detail and never proved the
  // gesture the drag was added to, so when the press began setting state — which remounts the very
  // block it started on, because JobBlock is declared inside the page component — the browser
  // dispatched no click at all and clicking a booking silently stopped opening its card. Live for a
  // day. 81 green clauses and not one of them noticed.
  //
  // Both halves now live here, because they are one gesture with two outcomes: travel past the
  // threshold moves the card, and anything less opens it.
  console.log('\n— a click opens the card, which is what the drag sits on top of —');
  await pg.goto(diaryUrl, { waitUntil: 'domcontentloaded' });
  await pg.waitForSelector(`[data-reg="${PREFIX}GEST"]`, { timeout: 30000 });
  /**
   * THE PROPERTY THAT OUTLIVES THIS GESTURE: the element the pointer went down on must still be in
   * the document at pointerup. A click requires ONE element for both, so a handler that remounts it
   * destroys the click without touching a click handler — which is why no amount of reading the
   * click path would have found this. Measured, not scanned.
   */
  await pg.evaluate((p) => {
    window.__press = {};
    document.addEventListener('pointerdown', () => { window.__press.down = document.querySelector(`[data-reg="${p}GEST"]`); }, true);
    document.addEventListener('pointerup', () => { window.__press.survived = document.contains(window.__press.down); }, true);
    window.__clicks = 0;
    document.addEventListener('click', (e) => { if (e.target?.closest?.('.diary-block')) window.__clicks += 1; }, true);
  }, PREFIX);
  const seat = await pg.evaluate((p) => { const r = document.querySelector(`[data-reg="${p}GEST"]`).getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + 10 }; }, PREFIX);
  const whereBefore = await prisma.jobCard.findUnique({ where: { id: dragCard }, select: { resource_id: true, start_at: true } });
  await pg.mouse.click(seat.x, seat.y);
  await pg.waitForSelector('[data-testid="diary-pane"]', { timeout: 20000 }).catch(() => {});
  const clicked = await pg.evaluate(() => ({
    survived: window.__press.survived,
    clicks: window.__clicks,
    pane: document.querySelector('[data-testid="diary-pane"]')?.getAttribute('data-card') ?? null,
  }));
  check('the element under the pointer SURVIVES the press — a press that sets state destroys its own click',
    clicked.survived === true, `document.contains(down-node) at pointerup = ${clicked.survived}`);
  check('  …so the browser dispatches a click at all', clicked.clicks === 1, `${clicked.clicks} click(s) on a block`);
  check('A PLAIN CLICK OPENS THE JOB CARD', clicked.pane === dragCard, `pane card = ${clicked.pane ?? 'NOT OPEN'}`);
  const whereAfter = await prisma.jobCard.findUnique({ where: { id: dragCard }, select: { resource_id: true, start_at: true } });
  check('  …and moves nothing', whereAfter.resource_id === whereBefore.resource_id && whereAfter.start_at.getTime() === whereBefore.start_at.getTime(),
    `${whereBefore.start_at.toISOString()} → ${whereAfter.start_at.toISOString()}`);

  // AND IT STILL WORKS AFTER A DRAG. The first version suppressed the post-drag click with a
  // boolean set on drag-end — left true forever when the pointer lands on another column and no
  // click arrives to clear it, so the next honest click was the one it ate.
  // CLOSE THE PANE THE CLICK ABOVE OPENED, or "the drag did not open the card" is measured against
  // a card the previous clause opened — green or red for a reason that has nothing to do with the
  // drag. Closed by its own button rather than by reloading, because a reload would also wipe the
  // in-memory suppression this sequence exists to test.
  await pg.click('[data-testid="diary-pane"] button:has-text("✕")');
  await pg.waitForFunction(() => !document.querySelector('[data-testid="diary-pane"]'), null, { timeout: 10000 }).catch(() => {});
  check('  …and the pane closes again, so the next clause measures the drag and not this click',
    (await pg.evaluate(() => !document.querySelector('[data-testid="diary-pane"]'))) === true);
  // RE-MEASURED, not reused: opening and closing the pane adds and removes a panel below the grid,
  // and the coordinates taken before the click are not the ones on screen after it.
  const geo2 = await pg.evaluate((args) => {
    const b = document.querySelector(`[data-reg="${args.p}GEST"]`).getBoundingClientRect();
    const c = document.querySelector(`[data-col-resource="${args.id}"]`).getBoundingClientRect();
    return { block: { x: b.left + b.width / 2, y: b.top + 10 }, col: { left: c.left, width: c.width, top: c.top } };
  }, { p: PREFIX, id: lift1.id });
  const col1b = geo2.col;
  await pg.mouse.move(geo2.block.x, geo2.block.y);
  await pg.mouse.down();
  await pg.mouse.move(col1b.left + col1b.width / 2, col1b.top + 12 * 60, { steps: 10 });
  await pg.mouse.up();
  await pg.waitForFunction(() => document.querySelector('[data-testid="move-result"]')?.getAttribute('data-ok') === '1', null, { timeout: 20000 }).catch(() => {});
  const draggedTo = await prisma.jobCard.findUnique({ where: { id: dragCard }, select: { resource_id: true, start_at: true } });
  const paneAfterDrag = await pg.evaluate(() => !!document.querySelector('[data-testid="diary-pane"]'));
  check('a DRAG still moves it', draggedTo.resource_id === lift1.id && draggedTo.start_at.getTime() === at1(12).getTime(), draggedTo.start_at.toISOString());
  // ASSERTED, NOT IMPLIED. This clause used to be named "…and did not open the card on the way"
  // while checking only the move — a detail line naming a cause it had not established.
  check('  …and did not open the card on the way', paneAfterDrag === false, `pane open after the drag = ${paneAfterDrag}`);
  // NO RELOAD between the drag and the click. The real sequence is drag-then-click on one page
  // load, and a reload would wipe any in-memory suppression flag — hiding exactly the bug the
  // first version of this feature shipped with. The board refreshes itself through the router, so
  // the block is back in place without the page being thrown away.
  await pg.waitForSelector(`[data-reg="${PREFIX}GEST"]`, { timeout: 30000 });
  const seat2 = await pg.evaluate((p) => { const r = document.querySelector(`[data-reg="${p}GEST"]`).getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + 10 }; }, PREFIX);
  await pg.mouse.click(seat2.x, seat2.y);
  await pg.waitForSelector('[data-testid="diary-pane"]', { timeout: 20000 }).catch(() => {});
  const afterDrag = await pg.evaluate(() => document.querySelector('[data-testid="diary-pane"]')?.getAttribute('data-card') ?? null);
  check('…AND A CLICK STILL OPENS IT AFTER A DRAG', afterDrag === dragCard, `pane card = ${afterDrag ?? 'NOT OPEN'}`);
} catch (e) {
  check('run completed', false, describeError(e).slice(0, 400));
} finally {
  if (browser) await browser.close().catch(() => {});
  if (prisma && fix) {
    /**
     * BY PREFIX, NOT BY THE LIST OF IDS THIS GATE KEPT. The create-route clauses make a card
     * through /api/jobcard, which creates its OWN customer and vehicle — rows this gate never
     * learned the ids of. An id-list teardown removed the cards and left a ZZDRAG vehicle and two
     * ZZDRAG customers on the tenant, found by a residue sweep after a red-proof run.
     *
     * A teardown can only remove what it knows about, so it asks the same question the opening
     * sweep asks: everything under this prefix, however it got there.
     */
    const cards = await prisma.jobCard.findMany({
      where: { group_id: ZZ_GROUP, OR: [{ id: { in: fix.cardIds } }, { vehicle: { registration: { startsWith: PREFIX } } }, { customer: { name: { startsWith: PREFIX } } }] },
      select: { id: true },
    });
    await prisma.jobCard.deleteMany({ where: { id: { in: cards.map((c) => c.id) } } });
    await prisma.vehicle.deleteMany({ where: { group_id: ZZ_GROUP, registration: { startsWith: PREFIX } } });
    await prisma.customer.deleteMany({ where: { group_id: ZZ_GROUP, name: { startsWith: PREFIX } } });
    await prisma.resource.deleteMany({ where: { site: { group_id: ZZ_GROUP }, name: { startsWith: PREFIX } } }).catch(() => {});
    const left = await prisma.jobCard.count({ where: { group_id: ZZ_GROUP, vehicle: { registration: { startsWith: PREFIX } } } })
      + await prisma.vehicle.count({ where: { group_id: ZZ_GROUP, registration: { startsWith: PREFIX } } })
      + await prisma.customer.count({ where: { group_id: ZZ_GROUP, name: { startsWith: PREFIX } } })
      + await prisma.resource.count({ where: { site: { group_id: ZZ_GROUP }, name: { startsWith: PREFIX } } });
    check('teardown removed every fixture row, INCLUDING what the API created (audit rows stay — append-only)', left === 0, `${left} left`);
  }
  if (prisma) await prisma.$disconnect();
}
console.log(`\n${out.filter((c) => c === 'F').length} failures of ${out.length}`);
process.exit(out.includes('F') ? 1 : 0);
