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
} catch (e) {
  check('run completed', false, describeError(e).slice(0, 400));
} finally {
  if (browser) await browser.close().catch(() => {});
  if (prisma && fix) {
    await prisma.jobCard.deleteMany({ where: { id: { in: fix.cardIds }, group_id: ZZ_GROUP } });
    await prisma.vehicle.deleteMany({ where: { id: { in: fix.vehIds } } });
    await prisma.customer.delete({ where: { id: fix.custId } }).catch(() => {});
    await prisma.resource.deleteMany({ where: { id: { in: fix.lifts } } }).catch(() => {});
    const left = await prisma.jobCard.count({ where: { id: { in: fix.cardIds } } })
      + await prisma.vehicle.count({ where: { id: { in: fix.vehIds } } })
      + await prisma.customer.count({ where: { id: fix.custId } })
      + await prisma.resource.count({ where: { id: { in: fix.lifts } } });
    check('teardown removed every fixture row (audit rows stay — append-only)', left === 0, `${left} left`);
  }
  if (prisma) await prisma.$disconnect();
}
console.log(`\n${out.filter((c) => c === 'F').length} failures of ${out.length}`);
process.exit(out.includes('F') ? 1 : 0);
