/**
 * File: scripts/mot-lookup-refresh-gate.mjs
 * @gate-requires: none
 *
 * LOOK UP FOUND THE CAR, SO THE MOT NEVER GOT CHECKED.
 *
 * ── THE DEFECT ──────────────────────────────────────────────────────────────────────────────────
 * On 2026-11-02 the diary's booking form showed LC09XFU as "Filled from your records · MOT expired
 * 2026-07-23" for a car that had been tested since, and pressing Look up again could not fix it.
 * Nothing was broken: lookupVehicleByReg checks OUR RECORDS FIRST and returns the moment they
 * answer, because a returning car brings its owner, its open cards and its findings, and DVSA knows
 * none of those. The MOT is the one field on that form which can have changed somewhere else, and
 * it was the one field the records branch could never refresh. Measured the same day: 352 of 362
 * cars on that tenant carried a mot_checked_at, so this is not a never-checked backlog — it is an
 * ageing one, which no amount of pressing the button could move.
 *
 * ── WHAT IS GUARDED HERE ────────────────────────────────────────────────────────────────────────
 * Three things, and the third is the one that matters most.
 *
 *   1. THE CONDITION. motCheckReason is the only throttle on a DVSA call attached to a button a
 *      garage presses all day — one shared key, no cache, no cap, and a 429 that comes back
 *      indistinguishable from an unknown registration. A rule that said "refresh on every records
 *      hit" would read identically on the screen and spend the quota four times an afternoon on
 *      one car.
 *
 *   2. THE WIRING. /api/vehicle-lookup now returns the car's id, because the one client path had
 *      no way to name the car it had just found.
 *
 *   3. IT MUST NEVER CLAIM A CHECK IT DID NOT GET. mot_checked_at means DVSA ANSWERED. A banner
 *      stamped from a local `new Date()` after a silent call would say the date is confirmed on the
 *      screen where somebody is deciding whether a car may legally be driven to them. Both
 *      silences — DVSA not answering, and the fetch not completing — return checkedAt null, and the
 *      surface writes the server's stamp or nothing.
 *
 * refreshMotFromDvsa is exercised for REAL against a stubbed fetch, so its five outcomes are
 * behaviour here and not a source scan. The record it produces is then RENDERED through the actual
 * MotBanner component with react-dom/server, so the printed date is asserted as text — including
 * the case that matters most, where a silent check must leave the markup byte-identical.
 *
 * ── WHAT IS NOT PROVED HERE, AND WHO PROVES IT ──────────────────────────────────────────────────
 * Two things, said plainly rather than left to be assumed from a green run.
 *
 *   The DIARY's own call is read from SOURCE. That the condition is consulted first, that the
 *   handle is passed, that no local clock is written — all asserted as text, not executed. Driving
 *   the form needs a browser, a dev server and a fixture car, and a DVSA answer for a plate DVSA
 *   has never heard of, which is not a thing a gate can arrange.
 *
 *   So the END-TO-END check is MANUAL and was accepted as such by the owner (2026-11-02): after
 *   deploy, press Look up in the diary on a real vehicle whose stored MOT is stale and watch the
 *   date update. If that check has not been done, this gate being green does not say it works.
 */
import './_gate-preflight.mjs';
import './_ts.mjs';
const { readFileSync } = await import('node:fs');
const { hasKey } = await import('../lib/anchored-match.ts');
const R = await import('../lib/mot-refresh.ts');
const C = await import('../lib/vehicle-lookup-client.ts');

const out = [];
const check = (n, ok, d = '') => { out.push(ok ? 'P' : 'F'); console.log(`${ok ? '✓' : '✗'} ${n}${d ? `  — ${d}` : ''}`); };

const NOW = new Date('2026-11-04T11:00:00.000Z');
const daysAgo = (n, hh = '09:00') => new Date(`${new Date(Date.UTC(2026, 10, 4 - n)).toISOString().slice(0, 10)}T${hh}:00.000Z`);
const why = (checkedAt, now = NOW) => R.motCheckReason({ motCheckedAt: checkedAt }, now);

// ── 1. THE CONDITION, AND IT HAS THREE ANSWERS ─────────────────────────────────────────────────
console.log('\n— would we ask DVSA about this car? —');
check('the window is a week', R.MOT_CHECK_FRESH_DAYS === 7, `${R.MOT_CHECK_FRESH_DAYS} days`);
check('never stamped → never_checked', why(null) === 'never_checked');
check('  …and so is an absent field, not a crash', why(undefined) === 'never_checked');
check('  …and an empty string', why('') === 'never_checked');
check('  …and an UNREADABLE stamp, which tells us nothing about when we looked',
  why('not-a-date') === 'never_checked' && why(new Date('x')) === 'never_checked',
  'the safe reading of "nothing" is that nobody has looked');
check('checked today → null, do not ask', why(daysAgo(0)) === null);
check('checked exactly 7 days ago → null — the boundary is INSIDE the window',
  why(daysAgo(7)) === null, 'age > freshDays, so seven days old is still evidence');
check('checked 8 days ago → stale', why(daysAgo(8)) === 'stale');
check('checked a year ago → stale', why(daysAgo(365)) === 'stale');
check('a stamp in the FUTURE is clock skew, not evidence from tomorrow',
  why(new Date('2026-11-09T09:00:00.000Z')) === null, 'and must never read as stale');
check('a Date and its own ISO string give the same answer',
  why(daysAgo(8)) === why(daysAgo(8).toISOString()),
  'the column arrives as a Date on the server and a string through JSON');
check('day-grained, not instant-grained: 7 days + 2 hours ago is still 7 days',
  why(daysAgo(7, '23:00')) === null && why(daysAgo(8, '23:00')) === 'stale',
  'lib/calendar-days — the rule a person uses, and the one the MOT banner already uses');
check('the window is overridable, so a sweep can choose its own without a second rule',
  R.motCheckReason({ motCheckedAt: daysAgo(3) }, NOW, 1) === 'stale'
  && R.motCheckReason({ motCheckedAt: daysAgo(3) }, NOW, 30) === null);
check('THREE answers, not two', new Set([why(null), why(daysAgo(8)), why(daysAgo(1))]).size === 3,
  `${why(null)}, ${why(daysAgo(8))}, ${JSON.stringify(why(daysAgo(1)))}`);
{
  // THE RULE THAT WOULD HAVE LOOKED RIGHT. "Have we checked it?" is the boolean this replaces, and
  // it is exactly what left LC09XFU unrefreshable: 352 of 362 cars have a stamp, so a boolean says
  // "checked" for the whole fleet and never asks again.
  const BOOLEAN = (checkedAt) => (checkedAt ? null : 'never_checked');
  check('the clauses would CATCH the boolean rule the defect was made of',
    BOOLEAN(daysAgo(365)) === null && why(daysAgo(365)) === 'stale',
    'boolean: a year-old check is "checked". real: stale');
  // AND THE OPPOSITE ERROR. No condition at all reads identically on the screen and spends the
  // quota on every press.
  const ALWAYS = () => 'stale';
  check('  …and a rule with no condition, which spends the quota on a car checked an hour ago',
    ALWAYS(daysAgo(0)) === 'stale' && why(daysAgo(0)) === null);
}

// ── 2. THE CLIENT CALL, EXERCISED FOR REAL ─────────────────────────────────────────────────────
// A stubbed fetch, not a stubbed refresher: the function under test is the one the diary calls.
console.log('\n— refreshMotFromDvsa, against a stubbed fetch —');
const realFetch = globalThis.fetch;
const calls = [];
const stub = (impl) => { globalThis.fetch = async (url, init) => { calls.push({ url: String(url), init }); return impl(); }; };
const ok = (body) => () => ({ ok: true, json: async () => body });
const ANSWERED = { outcome: { kind: 'changed', sentence: 'MOT now expires 4 July 2027 — still due.', expiry: '2027-07-04', stillDue: true }, checkedAt: '2026-11-04T11:00:00.000Z' };
try {
  stub(ok(ANSWERED));
  calls.length = 0;
  const a = await C.refreshMotFromDvsa('veh-1');
  check('it POSTs the vehicle id to the EXISTING endpoint',
    calls.length === 1 && calls[0].url === '/api/mot-refresh' && calls[0].init?.method === 'POST'
    && JSON.parse(calls[0].init.body).vehicleId === 'veh-1',
    `${calls[0]?.init?.method} ${calls[0]?.url} ${calls[0]?.init?.body}`);
  check('  …and never caches, because the whole point is that it executes',
    calls[0].init?.cache === 'no-store');
  check('an answer is passed through unchanged — the sentence is not re-composed here',
    a.outcome.sentence === ANSWERED.outcome.sentence && a.outcome.expiry === '2027-07-04'
    && a.checkedAt === ANSWERED.checkedAt);

  stub(ok({ outcome: { kind: 'no_answer', sentence: 'DVSA didn’t answer — nothing was learned, so the date below is as old as it was.', expiry: null, stillDue: true }, checkedAt: null }));
  const b = await C.refreshMotFromDvsa('veh-1');
  check('DVSA SILENT: the outcome says so and checkedAt is null',
    b.outcome.kind === 'no_answer' && b.checkedAt === null,
    'a failed lookup stamps nothing — not the fields, and not mot_checked_at');

  stub(ok({ nothing: true }));
  const c = await C.refreshMotFromDvsa('veh-1');
  check('a 200 with NO outcome is a silence, not a success',
    c.outcome.kind === 'no_answer' && c.checkedAt === null, c.outcome.sentence);

  stub(() => ({ ok: false, json: async () => ({ outcome: { kind: 'changed', sentence: 'should never be read', expiry: '2030-01-01', stillDue: false } }) }));
  const d = await C.refreshMotFromDvsa('veh-1');
  check('a NON-OK response is a silence even when it carries a body',
    d.outcome.kind === 'no_answer' && d.checkedAt === null && d.outcome.expiry === null,
    'a 500 that happens to parse must not be read as an answer');

  globalThis.fetch = async () => { throw new Error('offline'); };
  const e = await C.refreshMotFromDvsa('veh-1');
  check('a THROWN fetch is a silence, and says it was ours rather than DVSA’s',
    e.outcome.kind === 'no_answer' && e.checkedAt === null && /didn’t complete/.test(e.outcome.sentence),
    e.outcome.sentence);
  check('  …and the two silences are told apart in the words, being fixed differently',
    e.outcome.sentence !== b.outcome.sentence);

  stub(ok({ outcome: ANSWERED.outcome, checkedAt: 1762254000000 }));
  const f = await C.refreshMotFromDvsa('veh-1');
  check('a checkedAt that is not a STRING becomes null rather than a truthy number',
    f.checkedAt === null, `${JSON.stringify(f.checkedAt)} — a truthy non-string would stamp the banner`);

  stub(ok(ANSWERED));
  const g = await C.refreshMotFromDvsa('veh-1');
  check('ONE SHAPE for every outcome, so no caller branches on a null reply',
    [a, b, c, d, e, f, g].every((x) => x && typeof x.outcome?.kind === 'string' && 'checkedAt' in x));
} finally {
  globalThis.fetch = realFetch;
}

// ── 3. THE WIRING, READ FROM SOURCE ───────────────────────────────────────────────────────────
// SAID PLAINLY: this half asserts the calls EXIST and are in the right order. It does not prove the
// screen shows the fresh date — that needs a browser, a dev server and a fixture car with an ageing
// stamp. What it does prove is the thing a type-check cannot: that the handle is returned, that the
// condition is consulted before the call, and that no local clock is written into the banner.
console.log('\n— the three pieces are connected (source) —');
const src = (f) => readFileSync(f, 'utf8');
/** Comments stripped: a file explaining what it does must not satisfy a check about doing it. */
const prose = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const api = prose(src('pages/api/vehicle-lookup.ts'));
const client = prose(src('lib/vehicle-lookup-client.ts'));
const diary = prose(src('pages/admin/diary.tsx'));

check('/api/vehicle-lookup returns the car’s id', hasKey(api, 'vehicleId', 'vehicle.id'),
  'without it the one client path cannot name the car it has just found');
check('  …and it is NOT inside the prefill object, where it would read as a form field',
  api.indexOf('vehicleId: vehicle.id') < api.indexOf('vehicle: {'),
  'every key of `vehicle` is mapped into an input; a handle is not a value to type');
check('the client carries it on the RECORDS branch', hasKey(client, 'vehicleId', /typeof data\.vehicleId/),
  'checked for a string, so a malformed body cannot put an object in a URL');

check('the diary consults the condition', diary.includes('motCheckReason('));
check('  …BEFORE it calls DVSA, not after',
  diary.indexOf('motCheckReason(') > 0 && diary.indexOf('refreshMotFromDvsa(') > diary.indexOf('motCheckReason('),
  'a condition evaluated after the call is not a throttle');
check('  …and only for a records hit, since the DVSA branch has just been to DVSA',
  /r\.source === 'records' && r\.vehicleId/.test(diary));
{
  // THE HONESTY CLAUSE, scoped to the block. `new Date().toISOString()` is CORRECT elsewhere on
  // this form — a DVSA answer this session does count as checked — so the scan must look only
  // where a silent call could be stamped as a verification.
  const start = diary.indexOf("if (r.source === 'records' && r.vehicleId)");
  const end = diary.indexOf('setMotBusy(false)', start);
  const block = start > 0 && end > start ? diary.slice(start, end) : '';
  check('the refresh block exists and was located', block.length > 0, `${block.length} chars`);
  check('  …it applies the SHARED rule rather than inlining its own',
    /applyMotRefresh\(prev, reply\)/.test(block),
    'the rule is lib/vehicle-lookup-client::applyMotRefresh, asserted above by rendering it');
  check('  …and writes no local clock of its own', !/new Date\(\)\.toISOString\(\)/.test(block),
    'correct elsewhere on this form, never here');
  // SCOPED TO THE BLOCK, like the two clauses above it. This was first written as
  // /finally \{[\s\S]*?setMotBusy\(false\)/ against the WHOLE file, and diary.tsx holds several
  // other finally blocks — so the lazy gap matched from one of THOSE through to this call, and the
  // clause stayed green when the finally was removed. Found by red-proving it, not by reading it:
  // the pattern looks anchored and is not. `block` ends immediately before setMotBusy(false), so
  // what has to be true is that the block's own tail is the finally that leads into it.
  check('  …and clears its busy flag in a FINALLY', /\}\s*finally\s*\{\s*$/.test(block),
    'this component is not remounted by a same-URL refresh, so a flag left set stays set');
}
check('the outcome is printed even when nothing was learned',
  /motBusy \|\| motMsg/.test(diary) && diary.includes('create-mot-refresh'),
  'silence after a check reads as confirmation');
check('and another plate clears the previous car’s result', /setMotMsg\(null\)/.test(diary));

// ── 3b. THE RECORD REACHES THE SCREEN, RENDERED ───────────────────────────────────────────────
// The REAL component, over the REAL state rule, over a REAL reply from refreshMotFromDvsa. Loaded
// through scripts/_ts-hook, which transpiles .tsx for exactly this — a component's printed words
// were previously assertable only through a browser.
console.log('\n— the banner, rendered before and after the check —');
{
  const React = (await import('react')).default;
  const { renderToStaticMarkup } = await import('react-dom/server');
  const MotBanner = (await import('../components/MotBanner.tsx')).default;
  const paint = (rec) => renderToStaticMarkup(React.createElement(MotBanner, {
    vehicle: { motExpiry: rec?.motExpiry ?? null, motCheckedAt: rec?.motCheckedAt ?? null,
               year: rec?.year ?? null, firstRegistered: rec?.firstRegistered ?? null },
    now: NOW, bookingAt: null,
  }));

  // LC09XFU's own shape: an expiry we hold, stamped by the August sweep and never since.
  const STALE = { motExpiry: '2026-07-23', motCheckedAt: daysAgo(93).toISOString(), year: 2009, firstRegistered: null };
  const before = paint(STALE);
  check('BEFORE: the stale record prints EXPIRED and the old date',
    before.includes('data-mot-state="expired"') && before.includes('2026-07-23'),
    'the screen the owner reported, reproduced from the record alone');
  check('  …and the condition says this car would be asked about',
    why(STALE.motCheckedAt) === 'stale');

  // A DVSA answer that lands inside the four-week window, so the new date is PRINTED rather than
  // the banner merely vanishing — both outcomes are asserted, this one first.
  stub(ok({ outcome: { kind: 'changed', sentence: 'MOT now expires 20 November 2026 — still due.', expiry: '2026-11-20', stillDue: true }, checkedAt: NOW.toISOString() }));
  const soonReply = await C.refreshMotFromDvsa('veh-1');
  const afterSoon = paint(C.applyMotRefresh(STALE, soonReply));
  check('AFTER an answer: the FRESH date is printed, and it is no longer expired',
    afterSoon.includes('2026-11-20') && !afterSoon.includes('2026-07-23')
    && afterSoon.includes('data-mot-state="due_soon"'),
    'the whole defect, end to end bar the DOM: stale date in, DVSA date out');

  // And a renewal well clear of the window removes the banner entirely.
  stub(ok({ outcome: { kind: 'changed', sentence: 'MOT renewed to 4 July 2027 — no longer due.', expiry: '2027-07-04', stillDue: false }, checkedAt: NOW.toISOString() }));
  const clearReply = await C.refreshMotFromDvsa('veh-1');
  check('AFTER a renewal clear of the window: no banner at all',
    paint(C.applyMotRefresh(STALE, clearReply)) === '',
    'a car with a year left is not news, and must not keep a red box');

  // THE ONE THAT MATTERS. A silence must change NOTHING a reader can see.
  stub(ok({ outcome: { kind: 'no_answer', sentence: 'DVSA didn’t answer — nothing was learned, so the date below is as old as it was.', expiry: null, stillDue: true }, checkedAt: null }));
  const silent = await C.refreshMotFromDvsa('veh-1');
  check('AFTER a SILENCE: the record is returned unchanged',
    C.applyMotRefresh(STALE, silent) === STALE, 'the same object, not a rebuilt copy of it');
  check('  …and the markup is BYTE-IDENTICAL to before the check',
    paint(C.applyMotRefresh(STALE, silent)) === before,
    'nothing a reader can see may move when nothing was learned');
  globalThis.fetch = realFetch;

  // RED-PROVED IN PLACE: the version that stamps a local clock on a silence. It paints a car as
  // CHECKED and erases the expiry, which reads as "DVSA says this car has no MOT".
  const DISHONEST = (prev, reply) => ({
    motExpiry: reply.outcome.expiry, motCheckedAt: reply.checkedAt ?? NOW.toISOString(),
    firstRegistered: prev?.firstRegistered ?? null, year: prev?.year ?? null,
  });
  check('the snapshot WOULD catch a local clock written on a silence',
    paint(DISHONEST(STALE, silent)) !== before
    && paint(DISHONEST(STALE, silent)).includes('data-mot-state="no_mot_'),
    `dishonest: ${paint(DISHONEST(STALE, silent)).includes('no_mot_probably_new') ? 'no_mot_probably_new' : 'no_mot_unknown'} — "DVSA says it has no MOT", from a call DVSA never answered`);
  check('  …and a stale record that is left alone still prints its own date',
    before.includes('2026-07-23') && paint(STALE) === before, 'the snapshot is stable, so a diff means a change');
}

// ── 4. THE SOURCE SCANS BITE ──────────────────────────────────────────────────────────────────
console.log('\n— proven on synthetic sources —');
check('the id scan does not count a mention in prose',
  !hasKey(prose("// we return vehicleId: vehicle.id one day\n"), 'vehicleId', 'vehicle.id'));
check('the id scan counts the real return', hasKey("    vehicleId: vehicle.id,\n", 'vehicleId', 'vehicle.id'));
check('the honesty scan WOULD catch a local stamp',
  /new Date\(\)\.toISOString\(\)/.test("setStoredMot({ motCheckedAt: new Date().toISOString() });"),
  'the clause above is green because the block does not do this, not because the scan cannot see it');
check('the FINALLY scan bites — it did not, and a red-proof found that',
  /\}\s*finally\s*\{\s*$/.test('  try { x(); } finally {')
  && !/\}\s*finally\s*\{\s*$/.test('  try { x(); } if (true) {'),
  'written against the whole file it matched another block entirely and stayed green');
check('the order scan would catch the call made before the condition',
  (() => { const bad = "await refreshMotFromDvsa(id); const w = motCheckReason(v, now);";
    return !(bad.indexOf('motCheckReason(') > 0 && bad.indexOf('refreshMotFromDvsa(') > bad.indexOf('motCheckReason(')); })());

console.log(`\n${out.filter((c) => c === 'F').length} failures of ${out.length}`);
process.exit(out.includes('F') ? 1 : 0);
