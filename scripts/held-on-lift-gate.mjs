/**
 * File: scripts/held-on-lift-gate.mjs
 * @gate-requires: db, server
 *
 * HELD ON LIFT — a car occupying a bay open-endedly while it waits for parts. The bay must not be
 * offered to anybody else, the diary must say how long it has been there, and the hold must end the
 * moment the card stops being work in progress.
 *
 * ── THE RULE THIS GATE EXISTS FOR ───────────────────────────────────────────────────────────────
 * A hold is DERIVED, never independently true: `held_since` set AND status `in_progress`. That is
 * the whole defence against a phantom hold, because `jobCard.status` has nine writers outside the
 * transition chokepoint and a "clear it here" statement in each is a rule that lasts until the
 * tenth writer. So the completeness clause below enumerates from JOB_STATUSES rather than naming
 * the statuses it happens to think of.
 *
 * ── AND THE TWO BOUNDED WINDOWS AN OPEN END COLLIDES WITH ───────────────────────────────────────
 * The clash guard finds candidates by `start_at >= newStart − PREFILTER_LOOKBACK_MS` (14 days) and
 * the day reader fetches by `end_at > rangeStart`. Both bound a booking by its END, and a hold has
 * none: a car held three weeks would fall out of the first and a car held past its planned end out
 * of the second. Each needs its own unbounded arm, and those arms are what the db clauses below
 * drive — not the maths, which cannot see a missing row.
 *
 * Fixtures on ZZ Gate Garage only, prefix ZZHELD, swept before and after. Never TMBS.
 */
import './_gate-preflight.mjs';
const { gatePrisma, describeError, ZZ_GROUP, zzSite, gateOrigin, serverReady } = await import('./_gate-preflight.mjs');
import './_ts.mjs';
const { readFileSync } = await import('node:fs');

const PREFIX = 'ZZHELD';
const { chromium } = await import('/Users/hugh/Developer/greasedesk-core/node_modules/playwright-core/index.mjs');

const out = [];
const check = (n, ok, d = '') => { out.push(ok ? 'P' : 'F'); console.log(`${ok ? '✓' : '✗'} ${n}${d ? `  — ${d}` : ''}`); };
const R = '/Users/hugh/Developer/greasedesk-core';
const H = await import(`${R}/lib/held-on-lift.ts`);
const S = await import(`${R}/lib/jobcard-status.ts`);
const CD = await import(`${R}/lib/calendar-days.ts`);
const OCC = await import(`${R}/lib/occupancy.ts`);

const DAY = 86_400_000;
// A Thursday, mid-morning, so "yesterday" is a Wednesday and the week has open days either side.
const NOW = new Date('2026-10-01T09:30:00Z');
const OPEN = 8, CLOSE = 18, WEEKDAYS = [1, 2, 3, 4, 5];
const LUNCH = [{ start: 13 * 60, end: 14 * 60 }];
const held = (iso, status = 'in_progress') => ({ status, held_since: new Date(iso) });
const tail = (card, dayISO, breaks = []) =>
  H.heldTailSegments({ card, dayStartISO: dayISO, openHour: OPEN, closeHour: CLOSE, openDays: WEEKDAYS, breaks });
const span = (s) => `${s.startISO.slice(11, 16)}–${s.endISO.slice(11, 16)}`;
const spans = (ss) => ss.map(span).join(' ');

let prisma = null;
let browser = null;
let fix = false;
try {

// ── A HOLD IS DERIVED FROM THE STATUS, NOT STORED AS A SECOND TRUTH ───────────────────────────
console.log('— the hold is derived —');

check('held_since + in_progress is a hold',
  H.isHeld(held('2026-09-28T10:00:00Z')) === true);

check('no held_since is not a hold, whatever the status',
  S.JOB_STATUSES.every((s) => H.isHeld({ status: s, held_since: null }) === false),
  `${S.JOB_STATUSES.length} statuses`);

// ENUMERATED FROM JOB_STATUSES, not from a list of statuses I thought of: the status added next
// year is the one that would otherwise keep a phantom hold alive. (lib/jobcard-status's own
// statusSubset discipline, applied to a gate clause.)
{
  const holds = S.JOB_STATUSES.filter((s) => H.isHeld({ status: s, held_since: new Date(NOW) }));
  check('EXACTLY ONE status can hold a bay, and it is the one the module names',
    holds.length === 1 && holds[0] === H.HELD_STATUS && H.HELD_STATUS === 'in_progress',
    `held by: ${holds.join(', ') || 'none'} of ${S.JOB_STATUSES.length}`);
}

// The statement the whole design rests on: no clearing code runs, so the hold must END by itself
// the moment the card moves. Every exit from in_progress, read from the transition table.
{
  const exits = S.nextTransitions('in_progress').map((t) => t.to);
  const stillHeld = exits.filter((to) => H.isHeld({ status: to, held_since: new Date(NOW) }));
  check('EVERY exit from in_progress ends the hold with no clearing code',
    exits.length > 0 && stillHeld.length === 0,
    `exits: ${exits.join(', ')}`);
}

check('the TIMESTAMP survives the move, so history stays readable',
  (() => {
    const row = { status: 'invoiced', held_since: new Date('2026-09-22T11:00:00Z') };
    return H.isHeld(row) === false && H.heldSinceMs(row) === null && row.held_since instanceof Date;
  })());

// THE SQL AND THE PREDICATE MUST SAY THE SAME THING. Two of the four readers are where-clauses and
// cannot call isHeld, so this asserts agreement rather than hoping the two were written in step.
check('HELD_WHERE and isHeld agree on every status',
  S.JOB_STATUSES.every((s) => (H.HELD_WHERE.status === s) === H.isHeld({ status: s, held_since: new Date(NOW) })),
  `HELD_WHERE.status=${H.HELD_WHERE.status}`);

check('HELD_WHERE requires the timestamp to be present',
  JSON.stringify(H.HELD_WHERE.held_since) === JSON.stringify({ not: null }));

// ── HOW LONG IT HAS BEEN THERE: CALENDAR DAYS, NOT ELAPSED HOURS ──────────────────────────────
console.log('— the day count —');

check('held this morning counts 0, so nothing is printed',
  H.heldDays(held('2026-10-01T08:15:00Z'), NOW) === 0);

// THE DISCRIMINATING CASE. Sixteen hours is less than one elapsed day and more than one calendar
// day; the two rules give different answers and only one of them matches what a person says.
check('held YESTERDAY afternoon counts 1 after sixteen hours (an elapsed-hours floor would say 0)',
  (() => {
    const since = '2026-09-30T17:30:00Z';   // 16h before NOW
    const elapsedFloor = Math.floor((NOW.getTime() - Date.parse(since)) / DAY);
    return H.heldDays(held(since), NOW) === 1 && elapsedFloor === 0;
  })());

check('nine days on a bay counts 9',
  H.heldDays(held('2026-09-22T09:30:00Z'), NOW) === 9);

check('a card that has moved on has NO count',
  H.heldDays({ status: 'invoiced', held_since: new Date('2026-09-22T09:30:00Z') }, NOW) === null
  && H.heldDays({ status: 'in_progress', held_since: null }, NOW) === null);

check('a held_since in the future never counts backwards',
  H.heldDays(held('2026-10-04T09:00:00Z'), NOW) === 0);

// ONE IMPLEMENTATION OF THE DAY COUNT. The MOT column already printed "28 days" for a 29-day date
// by subtracting instants; a second hand-rolled count here is how that returns.
check('the count IS calendarDayDiff, not a second implementation',
  (() => {
    const since = '2026-09-25T16:40:00Z';
    return H.heldDays(held(since), NOW) === CD.calendarDayDiff(new Date(since), NOW);
  })());

{
  const src = readFileSync(`${R}/lib/held-on-lift.ts`, 'utf8');
  const body = src.slice(src.indexOf('export function heldDays'), src.indexOf('export function heldTailSegments'));
  check('heldDays does no day arithmetic of its own',
    body.includes('calendarDayDiff') && !/86_?400_?000|\/\s*24|getUTCDate\(/.test(body),
    body.replace(/\s+/g, ' ').slice(0, 0) || 'via calendarDayDiff');
}

// ── THE TAIL: AN OPEN END, DRAWN WITHIN WORKING HOURS ─────────────────────────────────────────
console.log('— the tail —');

check('the day it began runs from held_since to close',
  spans(tail(held('2026-09-29T14:20:00Z'), '2026-09-29T00:00:00Z')) === '14:20–18:00',
  spans(tail(held('2026-09-29T14:20:00Z'), '2026-09-29T00:00:00Z')));

check('a later day is the WHOLE working day',
  spans(tail(held('2026-09-29T14:20:00Z'), '2026-09-30T00:00:00Z')) === '08:00–18:00');

check('a day BEFORE the hold draws nothing',
  tail(held('2026-09-29T14:20:00Z'), '2026-09-28T00:00:00Z').length === 0);

check('a closed day draws nothing',
  tail(held('2026-09-29T14:20:00Z'), '2026-10-03T00:00:00Z').length === 0,  // Saturday, not in WEEKDAYS
  'Saturday');

check('a card that is no longer in_progress draws NO tail',
  tail({ status: 'invoiced', held_since: new Date('2026-09-29T14:20:00Z') }, '2026-09-30T00:00:00Z').length === 0);

check('lunch splits the tail in two',
  spans(tail(held('2026-09-29T14:20:00Z'), '2026-09-30T00:00:00Z', LUNCH)) === '08:00–13:00 14:00–18:00');

check('a hold begun INSIDE lunch starts at the break end, never inside it',
  spans(tail(held('2026-09-29T13:30:00Z'), '2026-09-29T00:00:00Z', LUNCH)) === '14:00–18:00',
  spans(tail(held('2026-09-29T13:30:00Z'), '2026-09-29T00:00:00Z', LUNCH)));

check('a hold begun after close draws nothing that day, and the whole of the next open day',
  tail(held('2026-09-29T19:00:00Z'), '2026-09-29T00:00:00Z').length === 0
  && spans(tail(held('2026-09-29T19:00:00Z'), '2026-09-30T00:00:00Z')) === '08:00–18:00');

// THE DECISION, ASSERTED. The tail claims forward with no end date: stopping it at now would leave
// tomorrow's column looking free on a bay that has a car bolted to it, and the drop there refused
// by a guard nobody could see coming.
check('the tail CLAIMS FORWARD — a column a month ahead is still held',
  spans(tail(held('2026-09-29T14:20:00Z'), '2026-10-29T00:00:00Z')) === '08:00–18:00',
  'Thu 29 Oct');

check('every tail segment sits inside working hours',
  (() => {
    const days = ['2026-09-29', '2026-09-30', '2026-10-01', '2026-10-05', '2026-11-12'];
    const all = days.flatMap((d) => tail(held('2026-09-29T14:20:00Z'), `${d}T00:00:00Z`, LUNCH));
    return all.length > 0 && all.every((s) => {
      const h = (iso) => Number(iso.slice(11, 13)) * 60 + Number(iso.slice(14, 16));
      return h(s.startISO) >= OPEN * 60 && h(s.endISO) <= CLOSE * 60 && h(s.endISO) > h(s.startISO);
    });
  })());

check('tail segments never overlap one another',
  (() => {
    const ss = tail(held('2026-09-29T09:00:00Z'), '2026-09-30T00:00:00Z', LUNCH);
    if (ss.length < 2) return false;
    for (let i = 1; i < ss.length; i++) if (OCC.segmentsOverlap(ss[i - 1], ss[i])) return false;
    return true;
  })());

// ── notBefore: WHERE THE TAIL STARTS WHEN THE DIARY DRAWS IT ──────────────────────────────────
// The diary passes the booking's own end, so the hatch extends PAST the plan instead of sitting on
// top of the block for the hours the car was genuinely being worked on.
check('notBefore pushes the tail start past the booking\'s end',
  spans(H.heldTailSegments({ card: held('2026-09-29T10:00:00Z'), dayStartISO: '2026-09-29T00:00:00Z', openHour: OPEN, closeHour: CLOSE, openDays: WEEKDAYS, notBefore: '2026-09-29T16:00:00Z' })) === '16:00–18:00',
  spans(H.heldTailSegments({ card: held('2026-09-29T10:00:00Z'), dayStartISO: '2026-09-29T00:00:00Z', openHour: OPEN, closeHour: CLOSE, openDays: WEEKDAYS, notBefore: '2026-09-29T16:00:00Z' })));

check('notBefore in a LATER day leaves the earlier column empty',
  H.heldTailSegments({ card: held('2026-09-29T10:00:00Z'), dayStartISO: '2026-09-29T00:00:00Z', openHour: OPEN, closeHour: CLOSE, openDays: WEEKDAYS, notBefore: '2026-09-30T09:00:00Z' }).length === 0);

check('notBefore BEFORE held_since changes nothing — the hold still governs',
  spans(H.heldTailSegments({ card: held('2026-09-29T14:20:00Z'), dayStartISO: '2026-09-29T00:00:00Z', openHour: OPEN, closeHour: CLOSE, openDays: WEEKDAYS, notBefore: '2026-09-29T09:00:00Z' })) === '14:20–18:00');

check('a malformed notBefore is ignored, never treated as the epoch',
  spans(H.heldTailSegments({ card: held('2026-09-29T14:20:00Z'), dayStartISO: '2026-09-29T00:00:00Z', openHour: OPEN, closeHour: CLOSE, openDays: WEEKDAYS, notBefore: 'not-a-date' })) === '14:20–18:00');

check('a site with no open days has no tail anywhere',
  H.heldTailSegments({ card: held('2026-09-29T14:20:00Z'), dayStartISO: '2026-09-30T00:00:00Z', openHour: OPEN, closeHour: CLOSE, openDays: [] }).length === 0);

// ── THE TWO BOUNDED WINDOWS ───────────────────────────────────────────────────────────────────
// This is the section the slice exists for. The maths above cannot see a MISSING ROW: the clash
// guard finds candidates inside a 14-day window and the day reader bounds presence by end_at, and
// an open-ended hold falls out of both. Only real rows in a real database say whether it does.
console.log('\n— fixtures on ZZ: the two bounded windows —');
prisma = await gatePrisma();
const site = await zzSite(prisma);
const DB = await import(`${R}/lib/diary-booking.ts`);
const DD = await import(`${R}/lib/diary-day.ts`);
const LOOKBACK_DAYS = Math.round(DB.PREFILTER_LOOKBACK_MS / DAY);

const sweep = async () => {
  const cards = await prisma.jobCard.findMany({ where: { group_id: ZZ_GROUP, vehicle: { registration: { startsWith: PREFIX } } }, select: { id: true } });
  await prisma.jobCard.deleteMany({ where: { id: { in: cards.map((c) => c.id) } } });
  await prisma.vehicle.deleteMany({ where: { group_id: ZZ_GROUP, registration: { startsWith: PREFIX } } });
  await prisma.customer.deleteMany({ where: { group_id: ZZ_GROUP, name: { startsWith: PREFIX } } });
  await prisma.resource.deleteMany({ where: { site_id: site.id, name: { startsWith: PREFIX } } });
};
await sweep();
fix = true;

const cust = await prisma.customer.create({ data: { group_id: ZZ_GROUP, site_id: site.id, name: `${PREFIX} Fixture` }, select: { id: true } });
// A BAY PER SUBJECT. Fixtures sharing a bay make the product's refusals indistinguishable from one
// fixture sitting in another's way — which has already made a gate read as a product defect once.
const bayOld = (await prisma.resource.create({ data: { site_id: site.id, name: `${PREFIX} Bay Old`, type: 'lift' }, select: { id: true } })).id;
const bayNew = (await prisma.resource.create({ data: { site_id: site.id, name: `${PREFIX} Bay New`, type: 'lift' }, select: { id: true } })).id;
const bayFree = (await prisma.resource.create({ data: { site_id: site.id, name: `${PREFIX} Bay Free`, type: 'lift' }, select: { id: true } })).id;
const bayMoved = (await prisma.resource.create({ data: { site_id: site.id, name: `${PREFIX} Bay Moved`, type: 'lift' }, select: { id: true } })).id;

// ── THE SITE'S REAL HOURS, READ FROM THE ROW ──────────────────────────────────────────────────
// This said `site.open_hour ?? 8` and `site.open_days?.length ? … : [1,2,3,4,5,6]` against the
// object `zzSite` returns — which is `{ id }` and nothing else. So every one of those reads was
// undefined and the gate silently used Mon–SAT defaults while ZZ opens Mon–Fri. On a weekday the
// two agree closely enough that nothing showed; the day it mattered, the gate placed its "current
// open day" on a Saturday the product considers closed and then failed its own clause.
//
// A premise about the tenant has to be READ from the tenant. Fetched here, and asserted below, so
// a gate cannot again disagree with the hours the page renders with.
const siteRow = await prisma.site.findUnique({
  where: { id: site.id },
  select: { open_hour: true, close_hour: true, open_days: true, breaks: true },
});
const SOPEN = siteRow?.open_hour ?? 8, SCLOSE = siteRow?.close_hour ?? 18;
const SDAYS = siteRow?.open_days?.length ? siteRow.open_days : [1, 2, 3, 4, 5, 6];
check('premise: the gate uses the hours the SITE actually keeps, not a default',
  typeof siteRow?.open_hour === 'number' && Array.isArray(siteRow?.open_days) && siteRow.open_days.length > 0,
  `open ${SOPEN}:00–${SCLOSE}:00 on days ${JSON.stringify(SDAYS)}`);
// FROM THE REAL CLOCK, not a fixed date: a hold is judged against `now` by every reader, so a
// fixture dated to a hardcoded October would drift out of the relation it is meant to demonstrate
// and the refusal would be correctly absent — which is what the first run of this gate showed.
const REAL = new Date();
/**
 * ── THE DAY THIS GATE DRAWS ON, AND WHY IT IS NOT ALWAYS TODAY ──────────────────────────────────
 * ZZ opens Monday to Friday. Run on a Saturday or Sunday, the diary correctly has no working hours
 * and `heldTailSegments` correctly returns nothing — so a clause reading "a tail appears on TODAY's
 * diary" fails for being asked on the wrong day, not because anything is wrong.
 *
 * It was written and proved on a Thursday and would have failed every weekend since. The point of
 * the clause is that the tail reaches the PRESENT, not that the present is a Tuesday, so the gate
 * drives the most recent OPEN day at or before today and says so.
 *
 * Every fixture anchors on the same day for the same reason: a fixture placed by walking FORWARD
 * from a Sunday lands on Monday, on a different column from the one being read.
 */
const VIEW_DAY = (() => {
  let d = new Date(Date.UTC(REAL.getUTCFullYear(), REAL.getUTCMonth(), REAL.getUTCDate()));
  for (let i = 0; i < 7 && !SDAYS.includes(d.getUTCDay()); i++) d = new Date(d.getTime() - DAY);
  return d;
})();
const atHour = (dayOffset, hour) => {
  // Walk to an OPEN day, so a fixture is never placed on a closed day and refused for the wrong
  // reason. Anchored on VIEW_DAY, which is open by construction.
  let d = new Date(VIEW_DAY.getTime() + dayOffset * DAY);
  while (!SDAYS.includes(d.getUTCDay())) d = new Date(d.getTime() + DAY);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), hour, 0, 0));
};
const mkCard = async (n, status, start, mins, resourceId, heldSince = null) => {
  const veh = await prisma.vehicle.create({ data: { group_id: ZZ_GROUP, registration: `${PREFIX}${n}`, registration_normalized: `${PREFIX}${n}` }, select: { id: true } });
  const fp = OCC.computeFootprint(start.toISOString(), mins, SOPEN, SCLOSE, SDAYS, []);
  const card = await prisma.jobCard.create({
    data: {
      group_id: ZZ_GROUP, site_id: site.id, customer_id: cust.id, vehicle_id: veh.id, status,
      resource_id: resourceId, start_at: start, end_at: new Date(Date.parse(fp.endISO)),
      booking_duration_minutes: mins, held_since: heldSince,
    },
    select: { id: true },
  });
  return card.id;
};

// THE LAYOUT. One line per card; nothing shares a bay and an hour; bayFree stays empty.
//   OLD    bayOld    started and HELD 20 days ago  — outside the 14-day prefilter window
//   NEW    bayNew    started and HELD this morning — inside it
//   MOVED  bayMoved  held_since set, but INVOICED  — the derived rule must drop it
//   FILLER bayFree   nothing. Every booking attempt below that must SUCCEED goes here.
// Each hold begins DURING its own card's work, which is the only way one ever begins.
const BACK = LOOKBACK_DAYS + 6;
const oldStart = atHour(-BACK, 9);
const oldHeld = await mkCard('OLD', 'in_progress', oldStart, 120, bayOld, atHour(-BACK, 11));
// Its hold begins an hour INTO the work, so the tail's start and `held_since` differ and the clause
// below can tell whether the diary bounded the hatch by the booking's end.
const newHeld = await mkCard('NEW', 'in_progress', atHour(0, 9), 120, bayNew, atHour(0, 10));
const movedOn = await mkCard('MOVED', 'invoiced', atHour(-BACK, 9), 120, bayMoved, atHour(-BACK, 11));
const walkIn = await mkCard('WALKIN', 'accepted', atHour(1, 9), 60, bayFree);

// THE PREMISE, CHECKED RATHER THAN STATED. The clause below is only about the prefilter window if
// the attempted booking really is further from the hold's start than the prefilter searches back.
const attemptAt = atHour(1, 10);
check('premise: the OLD hold started further back than the clash prefilter looks',
  attemptAt.getTime() - oldStart.getTime() > DB.PREFILTER_LOOKBACK_MS,
  `gap ${Math.round((attemptAt - oldStart) / DAY)}d vs a ${LOOKBACK_DAYS}d prefilter`);

const place = (cardId, resourceId, start, mins = 60) => prisma.$transaction((tx) =>
  DB.placeJobCard(tx, { jobCardId: cardId, resourceId, start, workingMinutes: mins, siteIds: [site.id], act: 'book' }))
  .then(() => ({ ok: true, msg: '' }), (e) => ({ ok: false, msg: String(e?.message ?? '') }));

// THE CLAUSE THE WHOLE SLICE TURNS ON. A bay that frees itself after a fortnight because nobody
// updated a date is the failure the owner named: met on a Monday morning, with a car in the way.
{
  const r = await place(walkIn, bayOld, attemptAt);
  check('a car held LONGER THAN THE PREFILTER WINDOW still blocks its bay',
    !r.ok && r.msg.startsWith('HELD_ON_LIFT:'), `${r.ok ? 'ALLOWED' : r.msg}`);
  check('  …and the refusal names the HELD car, not a generic clash',
    r.msg === `HELD_ON_LIFT:${PREFIX}OLD`, r.msg);
}

{
  const r = await place(walkIn, bayNew, atHour(0, 14));
  check('a car held TODAY blocks its bay', !r.ok && r.msg.startsWith('HELD_ON_LIFT:'), r.ok ? 'ALLOWED' : r.msg);
}

// THE DERIVED RULE, IN SQL. Nothing cleared this card's timestamp; it stopped being a hold because
// the card stopped being in progress. If this refuses, the where-clause is reading the column.
{
  const r = await place(walkIn, bayMoved, atHour(2, 10));
  check('a held_since on a card that MOVED ON does not block anything',
    r.ok || !r.msg.startsWith('HELD_ON_LIFT:'), r.msg || 'allowed');
}

// A booking whose whole footprint sits BEFORE the hold began is a historical slot, not a claim on
// the bay now, and is still allowed. The open end is forward-only.
{
  const before = atHour(-BACK - 4, 9);
  const r = await place(walkIn, bayOld, before);
  check('a booking entirely BEFORE the hold began is still allowed', r.ok, r.msg || 'allowed');
  await prisma.jobCard.update({ where: { id: walkIn }, data: { resource_id: bayFree, start_at: atHour(1, 9), end_at: atHour(1, 10), booking_duration_minutes: 60 } });
}

check('a hold on one bay does not block a DIFFERENT bay',
  (await place(walkIn, bayFree, atHour(2, 10))).ok);
await prisma.jobCard.update({ where: { id: walkIn }, data: { resource_id: bayFree, start_at: atHour(1, 9), end_at: atHour(1, 10), booking_duration_minutes: 60 } });

// ── AND THE DAY READER ────────────────────────────────────────────────────────────────────────
// The OLD hold's planned end was a fortnight ago. Under the end_at bound alone it is not on
// today's board at all, so the tail the diary is supposed to grow could never come into view.
{
  const d0 = new Date(Date.UTC(REAL.getUTCFullYear(), REAL.getUTCMonth(), REAL.getUTCDate()));
  const rows = await DD.fetchDayBookings(site.id, d0, new Date(d0.getTime() + DAY));
  const ids = rows.map((r) => r.id);
  check('a car held since before its planned end is STILL on today\'s board',
    ids.includes(oldHeld), `${rows.length} rows`);
  check('  …and carries held_since, so the tail can be drawn',
    !!rows.find((r) => r.id === oldHeld)?.held_since);
  // The arm must not have widened the board to every finished card ever.
  check('a card that is NOT held and whose end has passed stays off the board',
    !ids.includes(movedOn), movedOn);
}

// ── THE HOLD ITSELF, THROUGH ITS OWN DOOR ─────────────────────────────────────────────────────
console.log('\n— the hold API —');
await serverReady();
const origin = gateOrigin();
browser = await chromium.launch({ channel: 'chrome' });
const ctx = await browser.newContext({ viewport: { width: 1400, height: 950 } });
const pg = await ctx.newPage();
await pg.goto(`${origin}/admin/login`, { waitUntil: 'domcontentloaded' });
await pg.fill('input[type="email"]', 'owner@zzgategarage.test');
await pg.fill('input[type="password"]', 'GateGarage!2026');
await Promise.all([pg.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 60000 }), pg.click('button[type="submit"]')]);
const hold = (body) => pg.evaluate(async (b) => {
  const r = await fetch('/api/jobcard-hold', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin', body: JSON.stringify(b) });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}, body);

// A hold is a fact about work in progress, refused rather than written where nothing would read it.
{
  const r = await hold({ jobCardId: walkIn, held: true });
  check('holding a bay is REFUSED on a card that is not in progress', r.status === 409, `${r.status} ${r.body?.message ?? ''}`);
  const row = await prisma.jobCard.findUnique({ where: { id: walkIn }, select: { held_since: true } });
  check('  …and nothing was written', row.held_since === null);
}

// IT NEVER REFUSES BECAUSE OF A LATER BOOKING. Recording reality is not blocked by a consequence
// of reality — the car is on the bay whatever the diary says. The response names what is now stuck.
{
  const blocker = await mkCard('BLOCK', 'in_progress', atHour(0, 9), 60, bayFree);
  await prisma.jobCard.update({ where: { id: walkIn }, data: { resource_id: bayFree, start_at: atHour(3, 9), end_at: atHour(3, 10) } });
  const r = await hold({ jobCardId: blocker, held: true });
  const row = await prisma.jobCard.findUnique({ where: { id: blocker }, select: { held_since: true } });
  check('a hold is WRITTEN even when it strands a later booking', r.status === 200 && !!row.held_since, `${r.status}`);
  check('  …and the response NAMES what it has stranded',
    Array.isArray(r.body?.blocked) && r.body.blocked.includes(`${PREFIX}WALKIN`), JSON.stringify(r.body?.blocked));

  const again = await hold({ jobCardId: blocker, held: true });
  const rows = await prisma.auditLog.count({ where: { group_id: ZZ_GROUP, entity_id: blocker, action: 'hold.placed' } });
  check('holding a held card is idempotent — one audit row, not two', again.status === 200 && rows === 1, `${rows} rows`);

  const placed = await prisma.auditLog.findFirst({ where: { group_id: ZZ_GROUP, entity_id: blocker, action: 'hold.placed' }, select: { diff_json: true } });
  check('the audit row says WHEN, so "nine days" can be checked rather than believed',
    !!placed?.diff_json?.heldSince, JSON.stringify(placed?.diff_json));

  const rel = await hold({ jobCardId: blocker, held: false });
  const after = await prisma.jobCard.findUnique({ where: { id: blocker }, select: { held_since: true } });
  check('releasing clears the hold', rel.status === 200 && after.held_since === null);
  const relRow = await prisma.auditLog.findFirst({ where: { group_id: ZZ_GROUP, entity_id: blocker, action: 'hold.released' }, select: { diff_json: true } });
  check('  …and the release row carries the start it ENDED, which the card no longer holds',
    !!relRow?.diff_json?.heldSince, JSON.stringify(relRow?.diff_json));
  check('and the bay is bookable again once released',
    (await place(walkIn, bayFree, atHour(4, 10))).ok);
}

// UNPLACING CLEARS IT: a hold is a claim on a bay, and this card no longer has one.
{
  const unplaced = await mkCard('UNPL', 'in_progress', atHour(5, 9), 60, bayFree, atHour(5, 11));
  const r = await pg.evaluate(async (id) => {
    const res = await fetch(`/api/diary?jobCardId=${id}`, { method: 'DELETE', credentials: 'same-origin' });
    return { status: res.status };
  }, unplaced);
  const row = await prisma.jobCard.findUnique({ where: { id: unplaced }, select: { held_since: true, resource_id: true } });
  check('unplacing a held card clears the hold with the bay',
    r.status === 200 && row.resource_id === null && row.held_since === null, `${r.status}`);
}

// ── AND IT IS ON THE SCREEN ───────────────────────────────────────────────────────────────────
// None of the above would notice a tail that is computed and never drawn. The props could carry
// every segment while the block rendered nothing, and the suite would stay green — which is how
// the hoisted diary block came to have twenty-one values and no coverage.
console.log('\n— the tail on screen —');
{
  const ymd = (d) => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
  const sameDay = ymd(VIEW_DAY) === ymd(REAL);
  check('premise: there is an open day at or before today to draw on',
    SDAYS.includes(VIEW_DAY.getUTCDay()), `drawing ${ymd(VIEW_DAY)}${sameDay ? ' (today)' : ` — today (${ymd(REAL)}) is closed`}`);
  await pg.goto(`${origin}/admin/diary?site=${site.id}&view=day&date=${ymd(VIEW_DAY)}`, { waitUntil: 'networkidle' });
  const tails = await pg.$$('[data-testid="held-tail"]');
  check('a car held three weeks ago draws a tail on the CURRENT open day', tails.length > 0, `${tails.length} tails on ${ymd(VIEW_DAY)}`);

  /**
   * UNCONDITIONAL FROM HERE. These clauses used to live inside `if (tails.length)`, so a missing
   * tail did not merely fail one clause — it removed the six below it and the gate reported 55 of
   * 56 where it had been 62 of 62. A failure that shrinks its own denominator is the same defect as
   * a gate that throws mid-run: the tally describes what ran, not what should have.
   */
  {
    const tail = tails[0] ?? null;
    // GEOMETRY NEEDS PAINT: top/bottom inside the viewport is true of a display:none element, whose
    // rect is 0x0 at the origin. Size and offsetParent first, then position.
    const box = tail === null
      ? { w: 0, h: 0, mounted: false, days: null, text: '', bg: '', img: '', border: '' }
      : await tail.evaluate((el) => {
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      return {
        w: Math.round(r.width), h: Math.round(r.height), mounted: !!el.offsetParent,
        days: el.getAttribute('data-held-days'), text: (el.textContent || '').trim(),
        bg: cs.backgroundColor, img: cs.backgroundImage, border: cs.borderTopColor,
      };
    });
    check('  …with real size, actually laid out', box.w > 10 && box.h > 10 && box.mounted, `${box.w}x${box.h}`);
    // Measured from the day being DRAWN. The block's count comes from the server's `now`, so on a
    // weekend run those differ and the clause would be testing the wall clock, not the renderer.
    const expected = Math.round((Date.UTC(REAL.getUTCFullYear(), REAL.getUTCMonth(), REAL.getUTCDate()) - Date.UTC(oldStart.getUTCFullYear(), oldStart.getUTCMonth(), oldStart.getUTCDate())) / DAY);
    check('  …and it says HOW MANY DAYS, matching the calendar count', Number(box.days) === expected && box.text.includes(String(expected)), `${box.days} vs ${expected}, text "${box.text}"`);

    // IT IS NOT A GHOST. A ghost is a slot that went to waste and is now free; this is a slot that
    // is MORE occupied than planned, so it must not borrow the ghost's or the lunch band's grey.
    check('  …hatched, and NOT the ghost\'s grey', box.img.includes('repeating-linear-gradient') && !/^rgba?\(1?[0-5]?\d, *1[12]\d, *1[23]\d/.test(box.bg), `${box.bg} / ${box.img.slice(0, 40)}`);

    // Clicking it opens the card: on day five of a hold the tail is the only thing on screen for
    // that car, and the card would otherwise be unreachable from the diary.
    //
    // ASSERTED AGAINST THE CARD IT NAMES, AND AGAINST NOTHING BEING OPEN FIRST. A pane left open by
    // an earlier clause reads as this one succeeding; that mistake has been made in this suite.
    const paneBefore = await pg.$('[data-testid="diary-pane"]');
    check('  …nothing is open before the click', paneBefore === null);
    if (tail) await tail.click();
    await pg.waitForSelector('[data-testid="diary-pane"]', { timeout: 15000 }).catch(() => {});
    const paneCard = await pg.$eval('[data-testid="diary-pane"]', (el) => el.getAttribute('data-card')).catch(() => null);
    check('  …and clicking it opens THAT car\'s job card', paneCard === oldHeld, `${paneCard} vs ${oldHeld}`);

    // THE HATCH STARTS WHERE THE BOOKING STOPS, not where the hold began. Today's NEW card is booked
    // 09:00–11:00 and was held at 10:00: an unbounded tail would start at 10:00 and lie across the
    // block for the hour the car was genuinely being worked on.
    const newFrom = await pg.$eval(`[data-testid="held-tail"][data-card="${newHeld}"]`, (el) => el.getAttribute('data-from')).catch(() => null);
    check('the tail begins at the BOOKING\'s end, not at held_since', newFrom === '11:00', `${newFrom} (held at 10:00, booked to 11:00)`);
  }
}

// ── A HOLD IS NOT SOLD TIME ───────────────────────────────────────────────────────────────────
// The owner's one "must never": holding a bay must not count as sold or charged hours. Two ways it
// could, and both are asserted rather than assumed.
console.log('\n— a hold is not sold time —');
{
  // 1. THE BOOKING'S OWN LENGTH IS UNTOUCHED. Everything downstream — capacity, margin, the quote —
  //    reads `booking_duration_minutes`, so if a hold left that alone it cannot have sold anything.
  const held = await mkCard('SOLD', 'in_progress', atHour(0, 9), 120, bayFree);
  const before = await prisma.jobCard.findUnique({ where: { id: held }, select: { booking_duration_minutes: true, end_at: true } });
  await hold({ jobCardId: held, held: true });
  const during = await prisma.jobCard.findUnique({ where: { id: held }, select: { booking_duration_minutes: true, end_at: true } });
  await hold({ jobCardId: held, held: false });
  const after = await prisma.jobCard.findUnique({ where: { id: held }, select: { booking_duration_minutes: true, end_at: true } });
  check('holding a bay does not lengthen the booking',
    during.booking_duration_minutes === before.booking_duration_minutes
    && during.end_at.getTime() === before.end_at.getTime()
    && after.booking_duration_minutes === before.booking_duration_minutes,
    `${before.booking_duration_minutes} → ${during.booking_duration_minutes} → ${after.booking_duration_minutes} min`);

  // 2. AND THE NEW DAY-READER ARM DOES NOT LEAK REVENUE INTO A LATER PERIOD. The arm deliberately
  //    widened the board's population: a card whose planned end was last month is now fetched for
  //    THIS month. The money is period-matched by the booking's START, so it must not be counted
  //    again here — and that is a sentence about a filter nobody was looking at when the arm landed.
  // DERIVED, NOT A LITERAL DAY-OF-MONTH. `Date.UTC(y, m - 1, 15)` reads as "last month" and is what
  // date-constant-gate flags: a fixed day-of-month on a clock-derived month is in the FUTURE for the
  // first half of every month, and this fixture only means anything in the past. The 1st walked
  // forward to an open day is the same intent with no literal day in it.
  let lastMonth = new Date(Date.UTC(REAL.getUTCFullYear(), REAL.getUTCMonth() - 1, 1, 9, 0, 0));
  while (!SDAYS.includes(lastMonth.getUTCDay())) lastMonth = new Date(lastMonth.getTime() + DAY);
  const veh = await prisma.vehicle.create({ data: { group_id: ZZ_GROUP, registration: `${PREFIX}PAST`, registration_normalized: `${PREFIX}PAST` }, select: { id: true } });
  const pastCard = await prisma.jobCard.create({
    data: {
      group_id: ZZ_GROUP, site_id: site.id, customer_id: cust.id, vehicle_id: veh.id, status: 'in_progress',
      resource_id: bayMoved, start_at: lastMonth, end_at: new Date(lastMonth.getTime() + 2 * 3600000),
      booking_duration_minutes: 120, vat_rate: 20,
      items: { create: [{ item_type: 'labour', description: `${PREFIX} work`, qty: 2, unit_price: 100, vat_rate: 20 }] },
    },
    select: { id: true },
  });
  const ym = `${REAL.getUTCFullYear()}-${String(REAL.getUTCMonth() + 1).padStart(2, '0')}-01`;
  const bookedNow = async () => {
    await pg.goto(`${origin}/admin/diary?site=${site.id}&view=month&date=${ym}`, { waitUntil: 'networkidle' });
    return pg.$eval('[data-testid="finance-booked"]', (el) => el.textContent.trim()).catch(() => null);
  };
  const unheldTotal = await bookedNow();
  await prisma.jobCard.update({ where: { id: pastCard.id }, data: { held_since: new Date(lastMonth.getTime() + 3600000) } });
  const heldTotal = await bookedNow();
  check('a car held since LAST month adds nothing to THIS month\'s Booked',
    unheldTotal !== null && heldTotal === unheldTotal, `${unheldTotal} → ${heldTotal}`);
  check('  …and the fixture really is on the board (or the clause proved nothing)',
    (await pg.$$('[data-testid="held-tail"]')).length >= 0
    && (await DD.fetchDayBookings(site.id, new Date(Date.UTC(REAL.getUTCFullYear(), REAL.getUTCMonth(), 1)), new Date(Date.UTC(REAL.getUTCFullYear(), REAL.getUTCMonth() + 1, 1)))).some((r) => r.id === pastCard.id),
    'fetched into this month');
}

// ── THE SUPERSEDED BOOLEAN STAYS UNREAD ───────────────────────────────────────────────────────
// `JobCard.held_on_lift` cannot be dropped in the same breath as the column that replaces it: the
// DEPLOYED code still selects it, and this database is shared. So it sits there vestigial — and a
// vestigial column that something starts reading again is two sources of truth for one fact, with
// the hold reliable in one of them. The only live statement left may be the unplace clear.
{
  const { execFileSync } = await import('node:child_process');
  const hits = execFileSync('grep', ['-rna', '--include=*.ts', '--include=*.tsx', '-e', 'held_on_lift', '-e', 'heldOnLift',
    `${R}/lib`, `${R}/pages`, `${R}/components`], { encoding: 'utf8' })
    .split('\n').filter(Boolean)
    // Comments explaining the retirement, and the locale KEY name on the phone's chip, are not reads.
    .filter((l) => !/^\S+:\d+: *(\*|\/\/|\/\*)/.test(l))
    .filter((l) => !l.includes("t('heldOnLift')"))
    .filter((l) => !l.includes('held_on_lift: false'));   // the unplace clear, kept until the drop
  check('nothing reads the superseded held_on_lift boolean',
    hits.length === 0, hits.map((h) => h.replace(`${R}/`, '').slice(0, 70)).join(' | ') || 'none');
}

// ── EVERY DOOR THAT CAN BE REFUSED SAYS SO ────────────────────────────────────────────────────
// Enumerated from the CALL SITES of placeJobCard, not from a list of endpoints I remembered: the
// door added next year is the one that would otherwise answer a held bay with a 500.
{
  const { execFileSync } = await import('node:child_process');
  const grep = execFileSync('grep', ['-rla', '--include=*.ts', 'placeJobCard(tx', `${R}/pages`], { encoding: 'utf8' })
    .split('\n').filter(Boolean);
  const missing = grep.filter((f) => !readFileSync(f, 'utf8').includes("HELD_ON_LIFT:'.length"));
  check(`all ${grep.length} doors that place a booking map the held-bay refusal`,
    grep.length >= 4 && missing.length === 0, missing.map((f) => f.replace(`${R}/`, '')).join(', ') || 'all mapped');
}

} catch (e) {
  check('gate ran to completion', false, describeError(e));
} finally {
  try {
    if (prisma && fix) {
      const cards = await prisma.jobCard.findMany({ where: { group_id: ZZ_GROUP, vehicle: { registration: { startsWith: PREFIX } } }, select: { id: true } });
      await prisma.jobCard.deleteMany({ where: { id: { in: cards.map((c) => c.id) } } });
      await prisma.vehicle.deleteMany({ where: { group_id: ZZ_GROUP, registration: { startsWith: PREFIX } } });
      await prisma.customer.deleteMany({ where: { group_id: ZZ_GROUP, name: { startsWith: PREFIX } } });
      await prisma.resource.deleteMany({ where: { site: { group_id: ZZ_GROUP }, name: { startsWith: PREFIX } } }).catch(() => {});
      const left = await prisma.jobCard.count({ where: { group_id: ZZ_GROUP, vehicle: { registration: { startsWith: PREFIX } } } })
        + await prisma.vehicle.count({ where: { group_id: ZZ_GROUP, registration: { startsWith: PREFIX } } })
        + await prisma.customer.count({ where: { group_id: ZZ_GROUP, name: { startsWith: PREFIX } } })
        + await prisma.resource.count({ where: { site: { group_id: ZZ_GROUP }, name: { startsWith: PREFIX } } });
      console.log(`residue under ${PREFIX}: ${left}`);
    }
  } catch (e) { console.log(`teardown: ${describeError(e)}`); }
  if (browser) await browser.close().catch(() => {});
  if (prisma) await prisma.$disconnect().catch(() => {});
}

const fails = out.filter((c) => c === 'F').length;
console.log(`\n${out.length - fails} of ${out.length} clauses pass`);
if (fails) process.exit(1);
