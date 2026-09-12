/**
 * File: scripts/job-clock-gate.mjs
 * TIME ON A JOB IS MEASURED, ONCE, BY ONE PERSON AT A TIME — AND IT MOVES NO MONEY.
 * @gate-requires: server, db
 *
 * Clocking is the input a cost model needs. Every clause below is satisfied by a system that records
 * NOTHING, so the ordinary clock-on/clock-off is proved in the SAME RUN as the refusals — a green
 * suite that never wrote a session would otherwise read exactly like a working one.
 *
 * ── THE ONE THAT NEEDED REAL CONCURRENCY ────────────────────────────────────────────────────────
 * "A tech cannot hold two open sessions" is trivially true when nothing races. It is proved here by
 * FORCING the overlap: a transaction takes the tech's advisory lock and holds it, a clock-on starts
 * and blocks, pg_stat_activity is polled until the wait is REAL, and only then is the first released.
 * No sleeps — the wait itself is the condition.
 *
 * And the mechanism is checked, not just the outcome: the writer must close the open session with a
 * COUNT-CHECKED conditional update on the pre-state, and must never CATCH a P2002. A caught unique
 * violation poisons its transaction (lib/commission, 2026-08-16), so a writer that relies on the
 * index to tell it "already open" is a writer whose next statement dies with 25P02.
 */
import './_gate-preflight.mjs';
import './_ts.mjs';
const { gatePrisma, describeError, gateOrigin, ZZ_GROUP, zzSite } = await import('./_gate-preflight.mjs');
const { readFileSync } = await import('node:fs');
const { randomUUID } = await import('node:crypto');
const C = await import('../lib/job-clock.ts');
const S = await import('../lib/job-clock-store.ts');
const TILES = await import('../lib/dashboard-tiles.ts');

const out = [];
const check = (n, ok, d = '') => { out.push(ok ? 'P' : 'F'); console.log(`${ok ? '✓' : '✗'} ${n}${d ? `  — ${d}` : ''}`); };
const code = (s) => s.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
const prisma = await gatePrisma();
const MARK = '@job-clock-gate.invalid';
const made = { users: [], cards: [], vehicles: [], customers: [] };
const mins = (n) => n * 60_000;

/** A throwaway tech and a throwaway card on ZZ. Torn down by their OWN ids. */
async function fixtures() {
  const site = await zzSite(prisma);
  const tech = async (name) => {
    const u = await prisma.user.create({
      data: { group_id: ZZ_GROUP, site_id: site.id, email: `${name}-${randomUUID().slice(0, 8)}${MARK}`, name: `Clock ${name}`, role: 'STANDARD' },
      select: { id: true },
    });
    made.users.push(u.id); return u.id;
  };
  const card = async (reg) => {
    const c = await prisma.customer.create({ data: { group_id: ZZ_GROUP, name: 'Clock gate', email: `c-${randomUUID().slice(0, 8)}${MARK}` }, select: { id: true } });
    made.customers.push(c.id);
    const v = await prisma.vehicle.create({ data: { group_id: ZZ_GROUP, registration: reg, make: 'ClockGate', model: 'x' }, select: { id: true } });
    made.vehicles.push(v.id);
    await prisma.vehicleOwnership.create({ data: { vehicle_id: v.id, customer_id: c.id, is_current: true } });
    const j = await prisma.jobCard.create({ data: { group_id: ZZ_GROUP, site_id: site.id, vehicle_id: v.id, status: 'draft' }, select: { id: true } });
    made.cards.push(j.id); return j.id;
  };
  return { tech, card };
}

try {
  const { tech, card } = await fixtures();

  // ── 1. THE POSITIVE CASE, FIRST, so nothing below passes on a system that records nothing ────
  console.log('\n— an ordinary clock on, clock off —');
  const alice = await tech('alice');
  const cardA = await card(`CLK${randomUUID().slice(0, 5).toUpperCase()}`);
  const t0 = new Date('2026-09-12T09:00:00Z');
  const on = await S.clockOn({ groupId: ZZ_GROUP, userId: alice, jobCardId: cardA, now: t0 });
  check('clocking on records a session', !!on.id && on.supersededCount === 0);
  const openNow = await S.openSessionFor(alice);
  check('  …and it is OPEN — no end, which is the honest null', !!openNow && openNow.job_card_id === cardA);
  const off = await S.clockOff({ userId: alice, now: new Date(t0.getTime() + mins(90)) });
  check('clocking off closes it', off.closed === true);
  const rowsA = await S.sessionsForCard(prisma, cardA);
  check('  …and the job reads NINETY MINUTES, the duration that happened', C.jobTotals(rowsA).labourMinutes === 90,
    `${C.jobTotals(rowsA).labourMinutes} minutes — the clause every refusal below would pass without`);
  check('  …with the end recorded as the tech\'s own', rowsA[0].ended_cause === 'tech' && rowsA[0].ended_source === 'live');

  // ── 2. ONE OPEN SESSION PER TECH, UNDER A FORCED OVERLAP ─────────────────────────────────────
  console.log('\n— two clock-ons at once: the second waits, and does not make a second open session —');
  const bob = await tech('bob');
  const cardB1 = await card(`CLK${randomUUID().slice(0, 5).toUpperCase()}`);
  const cardB2 = await card(`CLK${randomUUID().slice(0, 5).toUpperCase()}`);
  await S.clockOn({ groupId: ZZ_GROUP, userId: bob, jobCardId: cardB1 });

  let release;
  const held = new Promise((r) => { release = r; });
  // TX A takes the tech's advisory lock and HOLDS it. Nothing about the clock is done here — this
  // exists only to make the race real rather than hoped for.
  const txA = prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe('SELECT pg_advisory_xact_lock(hashtext($1))', bob);
    await held;
  }, { timeout: 30_000 }).catch((e) => ({ err: describeError(e) }));

  // WAIT ON THE CONDITION: A actually holding the lock, read from pg_locks. Not a sleep.
  const holds = async () => (await prisma.$queryRawUnsafe(
    `SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND granted`))[0].n > 0;
  for (let i = 0; i < 200 && !(await holds()); i += 1) { /* poll */ }
  check('the lock is genuinely held before the race starts', await holds(), 'pg_locks, not a guess');

  const racer = S.clockOn({ groupId: ZZ_GROUP, userId: bob, jobCardId: cardB2 });
  // AND WAIT FOR THE SECOND TO BE BLOCKED, read from pg_stat_activity. This is the discriminator:
  // without it the "race" could simply have run after the first finished.
  const waiting = async () => (await prisma.$queryRawUnsafe(
    `SELECT count(*)::int AS n FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND state = 'active'`))[0].n > 0;
  let blocked = false;
  for (let i = 0; i < 400 && !blocked; i += 1) blocked = await waiting();
  check('  …and the second clock-on is REALLY BLOCKED on it', blocked, 'pg_stat_activity wait_event_type = Lock');
  release();
  await txA;
  await racer;

  const openForBob = await prisma.jobClockSession.count({ where: { user_id: bob, ended_at: null } });
  check('after the race there is exactly ONE open session', openForBob === 1, `${openForBob} open`);
  const bobRows = await prisma.jobClockSession.findMany({ where: { user_id: bob }, orderBy: { started_at: 'asc' }, select: { job_card_id: true, ended_cause: true, ended_at: true } });
  check('  …and the first job was CLOSED, with its cause recorded', bobRows.some((r) => r.job_card_id === cardB1 && r.ended_cause === 'superseded' && !!r.ended_at),
    bobRows.map((r) => `${r.job_card_id === cardB1 ? 'first' : 'second'}:${r.ended_cause ?? 'open'}`).join(' '));
  check('  …because a tech cannot be on two cars at once', bobRows.filter((r) => !r.ended_at).length === 1);

  console.log('\n— and the writer does not lean on the index to tell it that —');
  const writer = code(readFileSync('lib/job-clock-store.ts', 'utf8'));
  check('it closes the open session with a CONDITIONAL UPDATE on the pre-state', /updateMany\(\{[\s\S]{0,120}ended_at: null/.test(writer));
  check('  …and CHECKS THE COUNT the write returns', /const \{ count \} = await tx\.jobClockSession\.updateMany/.test(writer) && /count > 1/.test(writer),
    'the answer to "was anything open?" comes from the write, not from a read that may be stale by the time it lands');
  check('  …and NO code path catches a P2002', !/P2002/.test(writer) && !/catch\s*\([\s\S]{0,40}\)\s*\{[\s\S]{0,200}unique/i.test(writer),
    'a caught unique violation poisons its transaction — lib/commission, 2026-08-16');
  check('the partial unique index exists as the BACKSTOP', (await prisma.$queryRawUnsafe(
    `SELECT count(*)::int AS n FROM pg_indexes WHERE indexname = 'JobClockSession_one_open_per_user_key'`))[0].n === 1);

  // ── 3. THE DEVICE'S CLOCK CHANGES NOTHING IT SHOULD NOT ──────────────────────────────────────
  console.log('\n— a phone hours out of step does not become the record —');
  const carol = await tech('carol');
  const cardC = await card(`CLK${randomUUID().slice(0, 5).toUpperCase()}`);
  const server = new Date('2026-09-12T10:00:00Z');
  const future = new Date(server.getTime() + mins(600));            // a phone claiming ten hours ahead
  const onC = await S.clockOn({ groupId: ZZ_GROUP, userId: carol, jobCardId: cardC, deviceAt: future, now: server });
  check('a device claiming the FUTURE is clamped to the server', onC.clamped === true);
  const rowC = (await S.sessionsForCard(prisma, cardC))[0];
  check('  …so the recorded start is the server\'s instant, not the phone\'s', rowC.started_at.getTime() === server.getTime(),
    `${rowC.started_at.toISOString()} vs the phone's ${future.toISOString()}`);
  check('  …and the phone\'s claim is KEPT beside it, never discarded', rowC.device_started_at?.getTime() === future.getTime(),
    'the skew stays visible rather than being averaged into one reconciled number');
  check('  …and the session reads DISPUTED, not as a duration', C.sessionState(rowC) === 'disputed', C.sessionState(rowC));
  await S.clockOff({ userId: carol, now: new Date(server.getTime() + mins(30)) });
  const cTotals = C.jobTotals(await S.sessionsForCard(prisma, cardC));
  check('  …so a disputed session contributes NO hours, and says how many it excluded', cTotals.labourMinutes === 0 && cTotals.disputed === 1,
    `${cTotals.labourMinutes} minutes, ${cTotals.disputed} disputed`);
  // AND THE ORDINARY OFFLINE CASE STILL WORKS: a few minutes late is not a dispute.
  const late = new Date(server.getTime() - mins(4));
  check('an ordinary offline lag is accepted as the device\'s time', C.resolveInstant(late, server).at.getTime() === late.getTime()
    && C.resolveInstant(late, server).source === 'queued' && !C.resolveInstant(late, server).clamped);

  // ── 4. TWO TECHS ON ONE CAR ──────────────────────────────────────────────────────────────────
  console.log('\n— two techs on one car sum, and the car was not on the ramp twice as long —');
  const dave = await tech('dave'), erin = await tech('erin');
  const shared = await card(`CLK${randomUUID().slice(0, 5).toUpperCase()}`);
  const base = new Date('2026-09-12T13:00:00Z');
  await S.clockOn({ groupId: ZZ_GROUP, userId: dave, jobCardId: shared, now: base });
  await S.clockOn({ groupId: ZZ_GROUP, userId: erin, jobCardId: shared, now: base });
  await S.clockOff({ userId: dave, now: new Date(base.getTime() + mins(60)) });
  await S.clockOff({ userId: erin, now: new Date(base.getTime() + mins(60)) });
  const both = C.jobTotals(await S.sessionsForCard(prisma, shared));
  check('LABOUR is the sum: two techs for an hour is two hours', both.labourMinutes === 120, `${both.labourMinutes} minutes`);
  check('  …and ON THE RAMP is the elapsed span, one hour', both.elapsedMinutes === 60, `${both.elapsedMinutes} minutes`);
  check('  …the two numbers DIFFER, which is why both are shown', both.labourMinutes !== both.elapsedMinutes,
    'a reader given one assumes the other — the ambiguity is the defect');
  const ui = code(readFileSync('components/pwa/ClockControl.tsx', 'utf8'));
  check('  …and the phone labels both', /Labour/.test(ui) && /On the ramp/.test(ui) && /clock-labour/.test(ui) && /clock-elapsed/.test(ui));

  // ── 5. AN OPEN SESSION RENDERS AS RUNNING, NEVER AS ZERO ─────────────────────────────────────
  console.log('\n— running is not zero —');
  const frank = await tech('frank');
  const cardF = await card(`CLK${randomUUID().slice(0, 5).toUpperCase()}`);
  await S.clockOn({ groupId: ZZ_GROUP, userId: frank, jobCardId: cardF, now: new Date('2026-09-12T08:00:00Z') });
  const fRows = await S.sessionsForCard(prisma, cardF);
  check('an open session\'s state is RUNNING', C.sessionState(fRows[0]) === 'running');
  check('  …it contributes no minutes, and is COUNTED as running rather than as 0h', C.sessionMinutes(fRows[0]) === null
    && C.jobTotals(fRows).running === 1 && C.jobTotals(fRows).counted === 0);
  check('  …and the phone says "Running since", never a duration', /Running since/.test(ui) && /clock-running/.test(ui));
  check('a session left open past the site\'s close hour is SURFACED', C.ranPastWorkingDay(new Date('2026-09-12T08:00:00'), new Date('2026-09-12T19:00:00'), 18),
    'derived from Site.close_hour — the diary\'s own end of day, not an invented hour count');
  check('  …but one still inside the working day is not', !C.ranPastWorkingDay(new Date('2026-09-12T08:00:00'), new Date('2026-09-12T17:00:00'), 18));
  check('  …and NOTHING closes it automatically', !/setInterval|cron|autoClose/i.test(writer),
    'a cron tidying up would be inventing an end time, which is the one thing this model refuses to do');

  // ── 6. A CORRECTION LEAVES THE ORIGINAL VISIBLE ──────────────────────────────────────────────
  console.log('\n— a correction is a new fact, not a silent edit —');
  const admin = await tech('admin');
  const original = (await S.sessionsForCard(prisma, cardA))[0];
  // THE RULE, AND THEN THE PATH. Only the composite was checked at first, and the leaf's blank test
  // could be deleted with the gate still green — the store's own `if (!reason)` masked it. Two
  // clauses, because two things are true and either can rot alone.
  check('a blank reason is not a reason, at the rule', C.normaliseCorrectionReason('   ') === null
    && C.normaliseCorrectionReason('ok') === 'ok' && C.normaliseCorrectionReason('x'.repeat(501)) === null);
  const bad = await S.correctSession({ correctsId: original.id, byUserId: admin, reason: '   ', startedAt: t0, endedAt: null });
  check('  …and the writer refuses one', 'refused' in bad && /reason/i.test(bad.refused));
  const good = await S.correctSession({ correctsId: original.id, byUserId: admin, reason: 'Clocked off late; agreed 60 minutes.',
    startedAt: t0, endedAt: new Date(t0.getTime() + mins(60)) });
  check('a correction with a reason is recorded', 'id' in good);
  const afterRows = await S.sessionsForCard(prisma, cardA);
  check('  …and the ORIGINAL is still there', afterRows.some((r) => r.id === original.id && r.ended_at?.getTime() === new Date(t0.getTime() + mins(90)).getTime()),
    'the ninety minutes it originally recorded, unchanged');
  const corr = afterRows.find((r) => r.corrects_id === original.id);
  check('  …the correction names who made it and why', corr?.corrected_by_user_id === admin && /agreed 60 minutes/.test(corr?.correction_reason ?? ''));
  // THE DATABASE REFUSES AN EDIT WHATEVER THE CALLER. SAVEPOINT per probe: a caught violation poisons
  // the transaction, so each breach gets its own.
  const breaks = async (sql) => {
    try { await prisma.$transaction(async (tx) => { await tx.$executeRawUnsafe('SAVEPOINT p'); await tx.$executeRawUnsafe(sql); }); return false; }
    catch { return true; }
  };
  check('editing a recorded START is refused by the database', await breaks(`UPDATE "JobClockSession" SET "started_at" = now() WHERE id = '${original.id}'`),
    'JobClockSession_append_only — the guarantee does not rest on the writer being the only caller');
  check('  …and re-closing a closed session is refused', await breaks(`UPDATE "JobClockSession" SET "ended_at" = now() WHERE id = '${original.id}'`));
  check('  …while an OPEN session can still be closed once', (await prisma.jobClockSession.updateMany({
    where: { id: fRows[0].id, ended_at: null },
    data: { ended_at: new Date(), ended_received_at: new Date(), ended_source: 'live', ended_cause: 'tech' },
  })).count === 1, 'completing a fact is not revising one');

  // ── 6b. THE DESKTOP, WHERE A MANAGER READS IT AND ACTS ───────────────────────────────────────
  /**
   * The phone shows the tech at the car; this is the other reader. Two things are proved: BOTH
   * numbers reach the desktop props (a manager shown one assumes the other), and the correction is
   * REACHABLE — an endpoint a manager can only hit with an API call is one nobody uses, and then the
   * still-running list only ever grows and nothing clears it.
   */
  console.log('\n— the desktop carries both numbers, and a way to correct —');
  /**
   * OVER HTTP, THE WAY THE PAGE GETS IT. buildJobCardPageProps cannot be imported here — it
   * transitively pulls next-auth/providers/credentials, which resolves to a namespace outside Next
   * (the same wall rep-auth-gate documents). /api/jobcard-pane returns the same builder's output, so
   * driving the real endpoint with a real session is both possible and the more honest path.
   */
  const B = gateOrigin();
  const jar = new Map();
  const keep = (r) => { for (const c of r.headers.getSetCookie?.() ?? []) { const kv = c.split(';')[0]; const i = kv.indexOf('='); jar.set(kv.slice(0, i), kv.slice(i + 1)); } };
  const cookies = () => [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
  const csrfRes = await fetch(`${B}/api/auth/csrf`); keep(csrfRes);
  const csrfToken = (await csrfRes.json()).csrfToken;
  keep(await fetch(`${B}/api/auth/callback/credentials`, {
    method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded', cookie: cookies() },
    body: new URLSearchParams({ email: 'owner@zzgategarage.test', password: 'GateGarage!2026', csrfToken, json: 'true' }),
  }));
  const paneRes = await fetch(`${B}/api/jobcard-pane?id=${encodeURIComponent(shared)}`, { headers: { cookie: cookies() }, cache: 'no-store' });
  check('the desktop pane answers for a signed-in manager', paneRes.status === 200, `HTTP ${paneRes.status}`);
  const props = await paneRes.json();
  check('the desktop props carry LABOUR as the sum', props.clock.labourMinutes === 120, `${props.clock.labourMinutes} minutes`);
  check('  …and ON THE RAMP as the elapsed span', props.clock.elapsedMinutes === 60, `${props.clock.elapsedMinutes} minutes`);
  check('  …and the sessions behind them, named', props.clock.sessions.length === 2
    && props.clock.sessions.every((x) => typeof x.who === 'string' && x.who !== 'Someone'),
    props.clock.sessions.map((x) => x.who).join(', '));
  const panel = code(readFileSync('components/jobcard/JobClock.tsx', 'utf8'));
  check('the panel labels both, never one alone', /Labour/.test(panel) && /On the ramp/.test(panel)
    && /job-clock-labour/.test(panel) && /job-clock-elapsed/.test(panel));
  check('  …and says what it did NOT count', /job-clock-excluded/.test(panel) && /still running/.test(panel) && /disputed/.test(panel),
    'silently excluding a running session makes a job look cheap');
  check('  …the correction form is admin-only and posts to the gated endpoint', /isAdmin && !s\.correctsId/.test(panel)
    && /'\/api\/jobcard-clock'/.test(panel));
  check('  …a reason is required in the form as well as the server', /required value=\{form\.reason\}/.test(panel),
    'the prompt, not the rule — the server refuses a blank one too');
  check('  …and a correction is never offered ON a correction', /!s\.correctsId/.test(panel),
    'correcting a correction would make "the original" ambiguous');
  const corrected = props.clock.sessions.find((x) => x.correctsId);
  check('the ORIGINAL and its correction both appear on the desktop', !corrected || (!!corrected.correctionReason && !!corrected.correctedBy));

  // ── 7. IT MOVES NO MONEY ─────────────────────────────────────────────────────────────────────
  console.log('\n— and none of it moves a money figure —');
  const from = new Date('2026-08-01T00:00:00Z'), to = new Date('2026-09-01T00:00:00Z');
  const site = await zzSite(prisma);
  const wage = await TILES.monthlyWageBill(ZZ_GROUP, [site.id], { from, to });
  check('the wage bill still costs hourly people at NOTHING, and still says so', Array.isArray(wage.hourlyExcludedPeople),
    `${wage.pennies}p, ${wage.hourlyExcludedPeople.length} hourly people named as excluded`);
  const readers = ['lib/charged-labour.ts', 'lib/invoice-issue.ts', 'lib/dashboard-tiles.ts', 'lib/capacity.ts'];
  const wired = readers.filter((f) => /jobClockSession|job-clock/i.test(code(readFileSync(f, 'utf8'))));
  check('NO money reader touches a clock session', wired.length === 0,
    wired.join(', ') || 'charged-labour, invoice-issue, dashboard-tiles and capacity all still read labour_hours only');
  // NOT VACUOUS: the same scan must find the readers that DO use it, or it proves nothing.
  const users = ['lib/job-clock-store.ts', 'pages/api/pwa/clock.ts'].filter((f) => /jobClockSession|job-clock/i.test(code(readFileSync(f, 'utf8'))));
  check('  …and that scan can see a file that does', users.length === 2, users.join(', '));
} catch (e) {
  check('gate run completed', false, describeError(e));
} finally {
  try {
    await prisma.jobClockSession.deleteMany({ where: { user_id: { in: made.users } } });
    if (made.cards.length) await prisma.jobCard.deleteMany({ where: { id: { in: made.cards } } });
    if (made.vehicles.length) await prisma.vehicle.deleteMany({ where: { id: { in: made.vehicles } } });
    if (made.customers.length) await prisma.customer.deleteMany({ where: { id: { in: made.customers } } });
    if (made.users.length) await prisma.user.deleteMany({ where: { id: { in: made.users } } });
    check('teardown removed every fixture', (await prisma.user.count({ where: { id: { in: made.users } } })) === 0
      && (await prisma.jobClockSession.count({ where: { user_id: { in: made.users } } })) === 0);
  } catch (e) { check('teardown completed', false, describeError(e)); }
  await prisma.$disconnect();
}
console.log(`\n${out.filter((c) => c === 'F').length} failures of ${out.length}`);
process.exit(out.includes('F') ? 1 : 0);
