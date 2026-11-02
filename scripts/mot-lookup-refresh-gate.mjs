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
const { hasKey, urlUnder } = await import('../lib/anchored-match.ts');
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

// ── THE POLICY MOVED, AND SO DID THESE CLAUSES ───────────────────────────────────────────────
// Everything from here to the end of this section used to read pages/admin/diary.tsx, because the
// condition, the call and the merge lived there. They now live in lib/vehicle-lookup-client, so
// these clauses follow them. All seventeen of them went RED when the code moved rather than
// quietly matching nothing, which is the only reason this re-pointing is a deliberate act and not
// a silent loss of cover. Which SURFACES obey the policy is section 9's business, not this one's.
const fn = (() => {
  const body = prose(src('lib/vehicle-lookup-client.ts'));
  const at = body.indexOf('export async function lookupAndFill');
  return at < 0 ? '' : body.slice(at);
})();
check('the shared function was located in source', fn.length > 0, `${fn.length} chars`);
check('it consults the condition', fn.includes('motCheckReason('));
check('  …BEFORE it calls DVSA, not after',
  fn.indexOf('motCheckReason(') > 0 && fn.indexOf('refreshMotFromDvsa(') > fn.indexOf('motCheckReason('),
  'a condition evaluated after the call is not a throttle');
check('  …and only for a records hit, since the DVSA branch has just been to DVSA',
  /if \(r\.source === 'records'\) \{/.test(fn) && /if \(r\.vehicleId && \(stale \|\| thin\)\)/.test(fn),
  'the branch is on the source; the CALL is additionally gated on the handle and the condition');
check('it computes staleness', /const stale = motCheckReason\(/.test(fn));
check('  …and thinness, from the MERGED values rather than the raw record',
  /const thin = isThinRecord\(\{ make: values\.make/.test(fn),
  'values is what the records merge produced — asking the raw record would ignore anything already typed');
check('  …and calls when EITHER is true', /if \(r\.vehicleId && \(stale \|\| thin\)\)/.test(fn), 'stale || thin');
check('ONE call serves both', (fn.match(/await refreshMotFromDvsa\(/g) ?? []).length === 1,
  'two calls would spend two of a shared key’s window to read the same payload');
check('the spec fields are merged through applyLookup, not assigned directly',
  /const second = applyLookup\(values as Record<string, string>, reply\.vehicle, r\.reg,/.test(fn),
  'the blanks-only rule is applyLookup’s, not re-implemented beside it');
check('  …with the echo licence from echoedKeys',
  hasKey(fn, 'overwritable', 'echoedKeys({ make: values.make, model: values.model })'));
check('  …and only on an answer', /if \(reply\.vehicle\)/.test(fn), 'a silence carries vehicle: null');
check('BOTH fills are kept, so clearStale can take both back',
  /fill = \{ \.\.\.fill, fields: \{ \.\.\.fill\.fields, \.\.\.second\.fill\.fields \} \}/.test(fn),
  'keeping only the second would forget what the records merge filled');
check('it applies the SHARED refresh rule rather than inlining one',
  /storedMot = applyMotRefresh\(storedMot, reply\)/.test(fn),
  'the rule is applyMotRefresh, asserted above by rendering it');
check('  …and writes no local clock into the stored record',
  !hasKey(fn, 'motCheckedAt', 'new Date()') && !hasKey(fn, 'motCheckedAt', 'now'),
  'mot_checked_at means DVSA ANSWERED — only the server’s own stamp may set it');
check('the line is composed by motLookupLine, not here',
  (fn.match(/motLookupLine\(\{/g) ?? []).length === 2 && !/`Checked /.test(fn),
  'both branches — records and DVSA — go through the one composer');
check('  …and is returned UNCONDITIONALLY, so a no-call press still speaks',
  (() => {
    const at = fn.indexOf('const motLine = r.source === ');
    if (at < 0) return false;
    const line = fn.slice(fn.lastIndexOf('\n', at) + 1, fn.indexOf(';', at));
    return /^\s*const motLine = /.test(line) && !/\bif\s*\(/.test(line);
  })(),
  'the LC09XFU case makes no call at all — a line reachable only through the call’s condition is the same blank screen again');
check('a DVSA-branch line uses the answer we just received',
  hasKey(fn, 'checkedAt', 'now') && hasKey(fn, 'failure', 'null'),
  'that branch HAS just been answered, so now is the honest stamp there');

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


// ── 5. THE SECOND QUESTION: IS THE RECORD THIN? ─────────────────────────────────────────────────
// Reported 2026-11-02, after the first fix was live: LC09XFU came back "Filled from your records"
// with make MINI, model MINI, and colour, year, fuel, engine and VIN all empty. The MOT half was
// working perfectly — the stamp was hours old, so the refresh correctly declined — and the record
// was still almost empty, because the records branch never reaches DVSA. Measured on production
// the same afternoon: 101 of 369 real-tenant cars (27%) are missing a field DVSA could supply.
console.log('\n— is what we hold worth asking DVSA for? —');
const FULL = { make: 'MINI', model: 'COOPER S', colour: 'Red', fuel: 'Petrol', year: '2014', engineCc: '1598' };
check('a fully-filled record is NOT thin', C.isThinRecord(FULL) === false, JSON.stringify(FULL));
for (const k of C.DVSA_FILLABLE) {
  const one = { ...FULL, [k]: '' };
  check(`  …but a blank ${k} makes it thin`, C.isThinRecord(one) === true, `${k} = ''`);
}
check('a null is as blank as an empty string', C.isThinRecord({ ...FULL, colour: null }) === true);
check('whitespace is blank too', C.isThinRecord({ ...FULL, colour: '   ' }) === true,
  'a space is not a colour');
check('a numeric 0 engine size is NOT treated as present-and-fine',
  C.isThinRecord({ ...FULL, engineCc: '' }) === true,
  'absence is a third state, never a zero (nullable-means-meaningful-absence)');

// VIN IS THE ONE THAT MUST NOT BE IN THE LIST. It is the commonest blank on the fleet — 97 cars,
// 26% — and DvsaVehicle carries no VIN at all, so including it would call DVSA for a quarter of the
// fleet to fill nothing. A lookup that can only fail, on one shared key.
check('VIN is NOT a reason to call DVSA', !C.DVSA_FILLABLE.includes('vin'),
  `DVSA_FILLABLE = ${C.DVSA_FILLABLE.join(', ')} — DvsaVehicle has no VIN, so 97 blank VINs must not trigger 97 calls`);
check('  …and a record thin ONLY in its VIN is not thin', C.isThinRecord({ ...FULL, vin: '' }) === false,
  'vin is not a member, so it cannot make the predicate true');
check('  …proved against lib/dvsa, not against this list',
  !/\bvin\b/.test(readFileSync('lib/dvsa.ts', 'utf8').slice(
    readFileSync('lib/dvsa.ts', 'utf8').indexOf('export type DvsaVehicle = {'),
    readFileSync('lib/dvsa.ts', 'utf8').indexOf('const API_BASE'))),
  'an independent oracle: the TYPE has no vin field, so the exclusion is a fact and not a preference');

console.log('\n— a model that merely repeats the make —');
check('MINI / MINI echoes', C.modelEchoesMake('MINI', 'MINI') === true);
check('  …case-insensitively', C.modelEchoesMake('Mini', 'MINI') === true);
check('  …and ignoring surrounding space', C.modelEchoesMake('MINI', '  MINI ') === true);
check('MINI / COOPER S does not echo', C.modelEchoesMake('MINI', 'COOPER S') === false);
check('two blanks do not echo each other', C.modelEchoesMake('', '') === false,
  'that is a blank record, which isThinRecord already catches — not an echo');
check('a blank make does not echo a filled model', C.modelEchoesMake('', 'COOPER') === false);
check('an echoing record is thin even though no field is empty',
  C.isThinRecord({ ...FULL, model: 'MINI' }) === true,
  'the column is not empty, which is why every blanks-only merge ever written has skipped these 58 cars');
check('echoedKeys names model and nothing else', JSON.stringify(C.echoedKeys({ make: 'MINI', model: 'MINI' })) === '["model"]');
check('  …and names nothing when there is no echo', JSON.stringify(C.echoedKeys({ make: 'MINI', model: 'COOPER' })) === '[]');
check('  …and never names MAKE, which it cannot judge',
  !C.echoedKeys({ make: 'Cooper', model: 'Cooper' }).includes('make'),
  'one real car holds make Cooper / model Cooper, where the MAKE is the wrong field — filling blanks cannot fix that and must not pretend to');

// ── 5b. THE MERGE CANNOT LEAVE THE FORM WORSE ───────────────────────────────────────────────────
// The property the ruling asked for by name. `overwritable` is a licence to REPLACE, never to
// CLEAR, and the ORDER of applyLookup's two guards is the whole of its safety.
console.log('\n— fill the blanks, and never make the form worse —');
const echoForm = { make: 'MINI', model: 'MINI', colour: '', fuel: '', year: '', engineCc: '' };
const over = C.echoedKeys(echoForm);
const r1 = C.applyLookup(echoForm, { model: 'COOPER S', colour: 'Red', year: '2014' }, 'LC09XFU', { overwritable: over });
check('an echoing model IS replaced when DVSA offers a real one', r1.values.model === 'COOPER S', r1.values.model);
check('  …and the blanks beside it are filled', r1.values.colour === 'Red' && r1.values.year === '2014');
check('  …and the replacement is REMEMBERED, so changing the plate takes it back',
  r1.fill.fields.model === 'COOPER S', JSON.stringify(r1.fill.fields));
const r2 = C.applyLookup(echoForm, { colour: 'Red' }, 'LC09XFU', { overwritable: over });
check('DVSA SILENT ON MODEL: the echoing value is KEPT, never cleared', r2.values.model === 'MINI',
  `model = ${JSON.stringify(r2.values.model)} — the "nothing offered" guard runs first and unconditionally`);
check('  …and is not recorded as a fill it never made', !('model' in r2.fill.fields), JSON.stringify(r2.fill.fields));
const r3 = C.applyLookup(echoForm, { model: '   ' }, 'LC09XFU', { overwritable: over });
check('a whitespace answer is "nothing offered", not a replacement', r3.values.model === 'MINI', JSON.stringify(r3.values.model));
const typed = { make: 'MINI', model: 'CLUBMAN', colour: 'Blue', fuel: '', year: '', engineCc: '' };
const r4 = C.applyLookup(typed, { model: 'COOPER S', colour: 'Red', fuel: 'Petrol' }, 'LC09XFU', { overwritable: C.echoedKeys(typed) });
check('A REAL MODEL IS NEVER OVERWRITTEN', r4.values.model === 'CLUBMAN',
  'CLUBMAN does not echo MINI, so it is not on the overwritable list at all');
check('  …nor is a typed colour', r4.values.colour === 'Blue', 'provably the operator’s, so it survives');
check('  …while the genuine blank beside them is still filled', r4.values.fuel === 'Petrol');
const r5 = C.applyLookup(echoForm, { model: 'MINI' }, 'LC09XFU', { overwritable: over });
check('an IDENTICAL answer is not recorded as a fill', !('model' in r5.fill.fields),
  'nothing changed, so clearStale has nothing to take back — otherwise changing the plate would blank a value DVSA confirmed');
const r6 = C.applyLookup(echoForm, { model: 'COOPER S' }, 'LC09XFU', {});
check('without the licence, an echoing model is left alone',
  r6.values.model === 'MINI', 'the default is unchanged: blanks only, nothing clobbered');

// ── 6. ONE LINE, ALWAYS — THE SILENT-SUCCESS DEFECT ─────────────────────────────────────────────
// THE CASE THIS EXISTS FOR, with the real numbers off the row. LC09XFU: mot_expiry 2027-10-06,
// mot_checked_at 09:23 the same morning. Both silences were correct — motBanner returns kind:'none'
// more than 28 days out, and motCheckReason declines inside its 7-day window — and together they
// produced a completely blank area of screen. It was reported as a broken feature, reasonably.
console.log('\n— after any look-up, exactly one line, and it speaks —');
// A DIFFERENT CLOCK FROM SECTION 1's, and named so: these clauses are about the day LC09XFU was
// reported, so the stamp and the expiry on them are that car's real values.
const LNOW = new Date('2026-11-02T17:00:00Z');
const lc09 = R.motLookupLine({ expiry: '2027-10-06', checkedAt: '2026-11-02T09:23:59.251Z', failure: null, now: LNOW });
check('LC09XFU now SAYS SOMETHING rather than nothing', typeof lc09 === 'string' && lc09.length > 0, lc09);
check('  …naming when it was checked', /09:23/.test(lc09), lc09);
check('  …and what it is valid to', /6 October 2027/.test(lc09), lc09);
check('  …as a claim about the FUTURE, not a bare date', /valid to/.test(lc09), lc09);
const older = R.motLookupLine({ expiry: '2027-08-05', checkedAt: '2026-08-24T10:00:00Z', failure: null, now: LNOW });
check('a stamp from another day shows the DAY, not a clock time', /24 Aug/.test(older) && !/\d\d:\d\d/.test(older), older);
const expired = R.motLookupLine({ expiry: '2026-07-23', checkedAt: '2026-11-02T09:23:00Z', failure: null, now: LNOW });
check('a PAST expiry is never "valid to"', !/valid to/.test(expired) && /expired 23 July 2026/.test(expired), expired);
const today = R.motLookupLine({ expiry: '2026-11-02', checkedAt: '2026-11-02T09:23:00Z', failure: null, now: LNOW });
check('an MOT expiring TODAY still reads as valid today', /valid to 2 November 2026/.test(today), today);
const noMot = R.motLookupLine({ expiry: null, checkedAt: '2026-11-02T09:23:00Z', failure: null, now: LNOW });
check('a car DVSA holds no MOT for says so', /no MOT recorded at DVSA/.test(noMot), noMot);
check('  …and is DIFFERENT from never having asked', noMot !== R.motLookupLine({ expiry: null, checkedAt: null, failure: null, now: LNOW }),
  'we asked and got nothing / nobody has asked — two states, not one');
const never = R.motLookupLine({ expiry: null, checkedAt: null, failure: null, now: LNOW });
check('never checked says exactly that', /Not checked with DVSA yet/.test(never), never);

// A FAILURE OUTRANKS THE DATE'S AGE. There is no honest way to print "checked 09:23" beside
// "we could not reach DVSA" — the reading that the failed call refreshed it is too easy.
for (const reason of ['rate_limited', 'not_found', 'forbidden', 'timeout']) {
  const line = R.motLookupLine({ expiry: '2027-10-06', checkedAt: '2026-11-02T09:23:00Z', failure: reason, now: LNOW });
  check(`a ${reason} check reports the FAILURE, not the stamp`,
    line === R.failureSentence(reason) && !/09:23/.test(line), line);
}
check('and the four failures do not all say the same thing',
  new Set(['rate_limited', 'not_found', 'forbidden', 'timeout'].map((x) =>
    R.motLookupLine({ expiry: '2027-10-06', checkedAt: null, failure: x, now: LNOW }))).size === 4);

// ── 7. (WAS: THE DIARY ASKS BOTH QUESTIONS) ─────────────────────────────────────────────────────
// Folded away deliberately. These clauses read pages/admin/diary.tsx for the condition, the single
// call and the merged fill — all of which moved into lookupAndFill, where section 3 now reads them,
// and whether each SURFACE obeys the policy is asserted for all three in section 9. Leaving a
// diary-only copy here would have been a third place to keep the same rule in step.

// ── 8. THE NEW SCANS BITE ───────────────────────────────────────────────────────────────────────
console.log('\n— the new clauses reject their broken variants —');
check('RP-T a thin rule that only looked at NULL would miss the 58 echoes',
  ((v) => !Object.values(v).some((x) => x == null))({ make: 'MINI', model: 'MINI' }) && C.isThinRecord({ ...FULL, model: 'MINI' }),
  'the naive predicate passes the echo; isThinRecord does not');
check('RP-U a merge WITHOUT the order guard would clear the model on a silence',
  (() => {
    // The broken variant: overwrite first, THEN check whether anything was offered.
    const bad = (cur, inc, over) => { const v = { ...cur }; for (const k of Object.keys(inc)) { if (over.includes(k)) v[k] = inc[k] ?? ''; } return v; };
    return bad(echoForm, { model: undefined }, ['model']).model === ''
      && C.applyLookup(echoForm, { model: undefined }, 'X', { overwritable: ['model'] }).values.model === 'MINI';
  })(),
  'the real one keeps MINI; the variant blanks it — which is "making the form worse"');
check('RP-V a line built only from a call would be empty on the no-call press',
  (() => { const bad = (reply) => reply ? 'something' : null; return bad(null) === null
    && R.motLookupLine({ expiry: '2027-10-06', checkedAt: '2026-11-02T09:23:00Z', failure: null, now: LNOW }).length > 0; })(),
  'this is exactly the LC09XFU silence, reproduced and then refuted');
check('RP-W a line that printed the stamp beside a failure would be caught',
  (() => { const bad = `Checked 09:23 — ${R.failureSentence('rate_limited')}`; return /09:23/.test(bad)
    && !/09:23/.test(R.motLookupLine({ expiry: '2027-10-06', checkedAt: '2026-11-02T09:23:00Z', failure: 'rate_limited', now: LNOW })); })(),
  'a failed call must not look like it refreshed anything');
check('RP-X the one-call clause would catch a second call',
  (() => { const bad = 'await refreshMotFromDvsa(a); await refreshMotFromDvsa(b);';
    return (bad.match(/await refreshMotFromDvsa\(/g) ?? []).length === 2; })(),
  'counted, not merely matched — a present-twice wiring fails');


// ── 9. ONE FUNCTION, EVERY SURFACE ──────────────────────────────────────────────────────────────
// REPORTED 2026-11-02, on production, after the diary fix was live: the NEW JOB CARD page said
// "Filled from your records" and nothing more for LC09XFU, S1CNE, L100BKY and KW21HLN. S1CNE's
// make, model, colour, year, fuel and engine stayed blank; L100BKY stayed MINI/MINI; no MOT line
// on any of them. Every one of those is the defect that had just been fixed — on a surface that
// held its own copy of what to do with a look-up and never got the fix.
//
// Three surfaces call the look-up. The policy now lives in lookupAndFill and the surfaces only set
// state, so this section asserts BOTH halves: the function behaves (exercised against a stubbed
// fetch, not scanned), and no surface has a second copy of the rule.
console.log('\n— lookupAndFill, exercised against stubbed endpoints —');
const realFetch2 = globalThis.fetch;
const seen = [];
/** Both endpoints, stubbed by URL: the records lookup and the refresh the records branch makes. */
const stubBoth = ({ records, refresh }) => {
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    seen.push(u);
    if (urlUnder(u, '/api/vehicle-lookup')) return { ok: true, json: async () => records };
    if (urlUnder(u, '/api/mot-refresh')) return { ok: true, json: async () => refresh };
    if (urlUnder(u, '/api/dvsa-lookup')) return { ok: true, json: async () => records };
    throw new Error(`unexpected ${u}`);
  };
};
// S1CNE AS IT ACTUALLY IS ON PRODUCTION: a records hit with make and model null, everything else
// empty, and a 70-day-old MOT stamp. Both conditions true at once.
const S1CNE_RECORDS = {
  found: true, vehicleId: 'veh-s1cne',
  vehicle: { registration: 'S1CNE', vin: '', mileage: null, make: '', model: '', colour: '', fuel: '', year: null, engineCc: null },
  storedMot: { motExpiry: '2027-08-17', motCheckedAt: '2026-08-24T10:00:00.000Z', firstRegistered: null, year: null },
  owner: { name: 'A Customer', phone: '07700 900000', email: 'a@example.com' },
  noShows: null, dueItems: [], openCards: [],
};
const DVSA_FILLED = {
  outcome: { kind: 'unchanged', failure: null, sentence: 'Checked just now — MOT date unchanged.', expiry: '2027-08-17', stillDue: false },
  checkedAt: '2026-11-02T17:00:00.000Z', reason: null,
  vehicle: { make: 'MINI', model: 'COOPER', colour: 'Silver', fuel: 'Petrol', year: 2009, engineCc: 1598 },
};
const BLANK_FORM = { cust: '', phone: '', email: '', vin: '', mileage: '', make: '', model: '', colour: '', fuel: '', year: '', engineCc: '' };
try {
  stubBoth({ records: S1CNE_RECORDS, refresh: DVSA_FILLED });
  seen.length = 0;
  const s1 = await C.lookupAndFill('S1CNE', BLANK_FORM, { ownerNameKey: 'cust', now: LNOW });
  check('S1CNE: a thin records hit REACHES DVSA', s1.ok && s1.dvsaCalled === true,
    `dvsaCalled=${s1.ok && s1.dvsaCalled} — this is the case that came back blank on the new-card page`);
  check('  …through the records endpoint FIRST, then the refresh',
    seen.length === 2 && urlUnder(seen[0], '/api/vehicle-lookup') && urlUnder(seen[1], '/api/mot-refresh'),
    seen.join(' → '));
  check('  …and the blanks are filled',
    s1.ok && s1.values.make === 'MINI' && s1.values.model === 'COOPER' && s1.values.colour === 'Silver'
    && s1.values.fuel === 'Petrol' && s1.values.year === '2009' && s1.values.engineCc === '1598',
    s1.ok ? JSON.stringify({ make: s1.values.make, model: s1.values.model, colour: s1.values.colour, fuel: s1.values.fuel, year: s1.values.year, engineCc: s1.values.engineCc }) : 'not ok');
  check('  …the owner lands on the CALLER’S key, not a guessed one',
    s1.ok && s1.values.cust === 'A Customer' && s1.values.phone === '07700 900000', s1.ok ? s1.values.cust : '');
  check('  …and there IS a line', s1.ok && typeof s1.motLine === 'string' && s1.motLine.length > 0, s1.ok ? s1.motLine : '');
  check('  …naming the stamp the SERVER returned, not a local clock',
    s1.ok && /17:00/.test(s1.motLine) && /17 August 2027/.test(s1.motLine), s1.ok ? s1.motLine : '');
  check('  …and BOTH fills are remembered, so changing the plate takes back both',
    s1.ok && s1.fill.fields.cust === 'A Customer' && s1.fill.fields.make === 'MINI',
    s1.ok ? Object.keys(s1.fill.fields).join(',') : '');

  // L100BKY: the ECHO. A records hit that is NOT stale and NOT blank — only its model repeats its
  // make — so the thin half alone has to carry the call.
  stubBoth({
    records: { ...S1CNE_RECORDS, vehicleId: 'veh-l100',
      vehicle: { registration: 'L100BKY', vin: 'X', mileage: '1', make: 'MINI', model: 'MINI', colour: 'Red', fuel: 'Petrol', year: 2009, engineCc: 1598 },
      storedMot: { motExpiry: '2027-08-05', motCheckedAt: LNOW.toISOString(), firstRegistered: null, year: null } },
    refresh: { ...DVSA_FILLED, vehicle: { make: 'MINI', model: 'COOPER S', colour: 'Red', fuel: 'Petrol', year: 2009, engineCc: 1598 } },
  });
  const l1 = await C.lookupAndFill('L100BKY', BLANK_FORM, { ownerNameKey: 'cust', now: LNOW });
  check('L100BKY: a FRESH stamp with an echoing model still reaches DVSA',
    l1.ok && l1.dvsaCalled === true, 'the thin half carries it — stale is false here');
  check('  …and the echo is replaced with a real model', l1.ok && l1.values.model === 'COOPER S', l1.ok ? l1.values.model : '');

  // AND THE CASE THAT MUST NOT CALL. Fresh stamp, nothing thin: the throttle.
  stubBoth({
    records: { ...S1CNE_RECORDS, vehicleId: 'veh-fresh',
      vehicle: { registration: 'LC09XFU', vin: 'X', mileage: '1', make: 'MINI', model: 'COOPER', colour: 'Red', fuel: 'Petrol', year: 2009, engineCc: 1598 },
      storedMot: { motExpiry: '2027-10-06', motCheckedAt: '2026-11-02T09:23:59.251Z', firstRegistered: null, year: null } },
    refresh: DVSA_FILLED,
  });
  seen.length = 0;
  const lc = await C.lookupAndFill('LC09XFU', BLANK_FORM, { ownerNameKey: 'cust', now: LNOW });
  check('LC09XFU: fresh AND full makes NO DVSA call', lc.ok && lc.dvsaCalled === false && seen.length === 1,
    `${seen.length} call(s) — one shared key, no cache, no cap of ours`);
  check('  …and STILL says something', lc.ok && /09:23/.test(lc.motLine) && /6 October 2027/.test(lc.motLine), lc.ok ? lc.motLine : '');

  // A REFRESH THAT FAILED. The line must report the failure, and nothing may be filled from it.
  stubBoth({
    records: S1CNE_RECORDS,
    refresh: { outcome: { kind: 'no_answer', failure: 'rate_limited', sentence: R.failureSentence('rate_limited'), expiry: null, stillDue: true }, checkedAt: null, reason: 'rate_limited', vehicle: null },
  });
  const rl = await C.lookupAndFill('S1CNE', BLANK_FORM, { ownerNameKey: 'cust', now: LNOW });
  check('a RATE-LIMITED refresh reports itself on the line',
    rl.ok && rl.motLine === R.failureSentence('rate_limited'), rl.ok ? rl.motLine : '');
  check('  …fills nothing from a call that did not answer',
    rl.ok && rl.values.make === '' && rl.values.colour === '', rl.ok ? `make=${JSON.stringify(rl.values.make)}` : '');
  check('  …but KEEPS what the records hit gave', rl.ok && rl.values.cust === 'A Customer', rl.ok ? rl.values.cust : '');
  check('  …and leaves the stored stamp exactly as it was',
    rl.ok && rl.storedMot?.motCheckedAt === '2026-08-24T10:00:00.000Z', rl.ok ? String(rl.storedMot?.motCheckedAt) : '');

  // THE DVSA BRANCH: a car we do not hold. No second call, and still a line.
  stubBoth({ records: { found: false }, refresh: DVSA_FILLED });
  globalThis.fetch = async (url) => {
    const u = String(url); seen.push(u);
    if (urlUnder(u, '/api/vehicle-lookup')) return { ok: true, json: async () => ({ found: false }) };
    if (urlUnder(u, '/api/dvsa-lookup')) return { ok: true, json: async () => ({ found: true, make: 'MINI', model: 'COOPER', colour: 'Blue', fuel: 'Petrol', year: 2015, engineCc: 1598, motExpiry: '2027-03-01' }) };
    throw new Error(`unexpected ${u}`);
  };
  seen.length = 0;
  const nu = await C.lookupAndFill('NEW1CAR', BLANK_FORM, { ownerNameKey: 'cust', now: LNOW });
  check('a NEW car falls through to DVSA and fills from it',
    nu.ok && nu.source === 'dvsa' && nu.values.make === 'MINI' && nu.values.colour === 'Blue', nu.ok ? nu.source : '');
  check('  …makes no refresh call, having just been to DVSA',
    !seen.some((u) => urlUnder(u, '/api/mot-refresh')), seen.join(' → '));
  check('  …and gets a line too', nu.ok && /1 March 2027/.test(nu.motLine), nu.ok ? nu.motLine : '');

  // A MISS. No line at all — there is no car to make a claim about.
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (urlUnder(u, '/api/vehicle-lookup')) return { ok: true, json: async () => ({ found: false }) };
    return { ok: true, json: async () => ({ found: false, reason: 'rate_limited' }) };
  };
  const miss = await C.lookupAndFill('NOSUCH1', BLANK_FORM, { ownerNameKey: 'cust', now: LNOW });
  check('a miss carries no line, and names the DVSA reason',
    !miss.ok && miss.motLine === null && miss.dvsaReason === 'rate_limited',
    `${!miss.ok ? miss.dvsaReason : 'ok'} — "enter them manually" is the wrong instruction for a 429`);

  // THE CALLER'S OTHER FIELDS SURVIVE. new.tsx passes its WHOLE form object through.
  const wide = { ...BLANK_FORM, registration: 'S1CNE', notes: 'keep me', complaint: 'rattle' };
  stubBoth({ records: S1CNE_RECORDS, refresh: DVSA_FILLED });
  const w = await C.lookupAndFill('S1CNE', wide, { ownerNameKey: 'cust', now: LNOW });
  check('every key the caller owns and the lookup does not is untouched',
    w.ok && w.values.notes === 'keep me' && w.values.complaint === 'rattle', w.ok ? JSON.stringify({ n: w.values.notes, c: w.values.complaint }) : '');
} finally {
  globalThis.fetch = realFetch2;
}

console.log('\n— and no surface keeps a second copy of the rule —');
const SURFACES = [
  ['pages/admin/diary.tsx', 'the diary quick-create'],
  ['pages/admin/jobcards/new.tsx', 'the new job card page'],
  ['components/jobcard/CustomerDetailsForm.tsx', 'the existing card’s details pane'],
];
// ENUMERATED FROM THE MODULE'S CALLERS, not from this list: a fourth surface added later must
// appear here or the completeness clause below fails. (completeness-clause-naming-convention.)
const callers = ['pages/admin/diary.tsx', 'pages/admin/jobcards/new.tsx', 'components/jobcard/CustomerDetailsForm.tsx',
  'pages/admin/marketing.tsx']
  .filter((f) => /lookupVehicleByReg\(|lookupAndFill\(/.test(src(f)));
check('every file that looks a registration up is one of the three named here',
  callers.length === SURFACES.length && callers.every((f) => SURFACES.some(([g]) => g === f)),
  callers.join(', '));
for (const [file, what] of SURFACES) {
  const body = prose(src(file));
  check(`${what}: calls lookupAndFill`, /await lookupAndFill\(/.test(body), file);
  check(`  …and does NOT call lookupVehicleByReg itself`, !/lookupVehicleByReg\(/.test(body),
    'the records-then-DVSA order is the policy, and a surface that starts the lookup itself owns it');
  check(`  …nor merges with applyLookup of its own`, !/applyLookup\(/.test(body),
    'blanks-only, the echo rule and the second merge all live in the one function now');
  check(`  …and prints the line from the function, never composing one`,
    /setMotLine\(r\.motLine\)/.test(body) && !/motLookupLine\(/.test(body), file);
  check(`  …clearing it when the plate changes`, /setMotLine\(null\)/.test(body),
    'another car’s result is not this car’s');
}
// THE RENDER, not just the state: a line held in state and never printed is the same blank screen.
for (const [file, what, testid] of [
  ['pages/admin/diary.tsx', 'the diary', 'create-mot-refresh'],
  ['pages/admin/jobcards/new.tsx', 'the new card page', 'new-mot-line'],
  ['components/jobcard/CustomerDetailsForm.tsx', 'the details pane', 'details-mot-line'],
]) {
  const body = prose(src(file));
  check(`${what} RENDERS it`, body.includes(testid) && new RegExp(`motLine[\\s\\S]{0,120}${testid}`).test(body),
    `data-testid="${testid}"`);
}
check('the diary no longer carries a busy flag nothing sets', !/motBusy/.test(prose(src('pages/admin/diary.tsx'))),
  'the whole look-up is one awaited call now, so lookBusy spans the DVSA call and a second flag would never fire');

// ── 10. THE SHARED-FUNCTION CLAUSES BITE ────────────────────────────────────────────────────────
console.log('\n— rejecting the shapes this replaced —');
const OLD_NEW_TSX = "const r = await lookupVehicleByReg(form.registration);\n  const { values, fill: f } = applyLookup(p, {...}, r.reg, { mot: !!r.mot });";
check('RP-Y the per-surface scan rejects the new-card page as it WAS',
  /lookupVehicleByReg\(/.test(OLD_NEW_TSX) && /applyLookup\(/.test(OLD_NEW_TSX)
  && !/lookupVehicleByReg\(/.test(prose(src('pages/admin/jobcards/new.tsx'))),
  'the exact pre-change shape fails both clauses; the current file fails neither');
check('RP-Z the render clause rejects state that is never printed',
  (() => { const bad = "const [motLine, setMotLine] = useState(null);\n  setMotLine(r.motLine);"; return !/data-testid="new-mot-line"/.test(bad); })(),
  'a line in state and absent from the markup is the blank screen all over again');
check('RP-AA the completeness clause would see a FOURTH surface',
  (() => {
    const pretend = ['a.tsx', 'b.tsx', 'c.tsx', 'd.tsx'];
    return pretend.length !== SURFACES.length;
  })(),
  'the list is checked against the files that actually call, so a new caller must be named here');

console.log(`\n${out.filter((c) => c === 'F').length} failures of ${out.length}`);
process.exit(out.includes('F') ? 1 : 0);
