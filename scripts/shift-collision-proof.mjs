/**
 * File: scripts/shift-collision-proof.mjs
 * @gate-requires: db
 *
 * DOES THE TWO-PASS DATE SHIFT SURVIVE A UNIQUE INDEX? Proved on the GATE database.
 *
 *   node scripts/shift-collision-proof.mjs
 *
 * ── WHAT THIS IS FOR ────────────────────────────────────────────────────────────────────────────
 * demo-shift-dates.mjs moved a demo tenant's dates forward with one UPDATE per column. On
 * production it failed:
 *
 *   23505  CostInstance (cost_id, period_start) = (b334c453-…, 2025-10-01) already exists
 *
 * The transaction rolled back and nothing was lost, but the shift was unrunnable and the fault was
 * invisible to every check it had: the set is unique before, unique after, and the dry run computes
 * only those two states. The collision lives inside the statement.
 *
 * So the fix is proved the only way that means anything — by building rows that collide and
 * watching the OLD sql fail on them before watching the NEW sql succeed. A fixture that does not
 * first reproduce the bug proves that the test is decoration, not that the code is right.
 *
 * ── IT RUNS THE REAL STATEMENTS ─────────────────────────────────────────────────────────────────
 * Both halves come from scripts/_shift-sql.mjs, the module demo-shift-dates.mjs itself imports.
 * Re-deriving the SQL here would mean checking a second copy of the idea against the first, which
 * agrees with itself whatever either one does. The oracle is Postgres raising 23505, not this file.
 *
 * ── GATE DATABASE, THROWAWAY ROWS, NARROW SCOPE ─────────────────────────────────────────────────
 * gatePrisma() declines unless the endpoint AND the Environment marker both say test, so this
 * cannot reach production. The fixture hangs off the standing ZZ tenant and is removed in teardown.
 *
 * The scope passed to the statement builder names THIS fixture's parent row (`cost_id = $1`), not
 * the tenant. Production's scope is `cost_id IN (SELECT id FROM "Cost" WHERE group_id = $1)`, and
 * using that here would have shifted every other ZZ fixture's cost instances as a side effect of
 * running a test. The collision behaviour is identical either way; the blast radius is not.
 */
import './_gate-preflight.mjs';
// gatePrisma reaches lib/db.ts, which imports through the repo's "@/..." aliases — the hook that
// resolves them is registered by _ts.mjs, as in every other gate. Without it the only symptom is
// `Cannot find package '@/lib'` from a line that looks nothing like the cause.
import './_ts.mjs';
const { gatePrisma, describeError, ZZ_GROUP, zzSite, onTeardown } = await import('./_gate-preflight.mjs');
const { shiftStatements, uniqueCoveredColumns } = await import('./_shift-sql.mjs');

const out = [];
const check = (n, ok, d = '') => { out.push(ok ? 'P' : 'F'); console.log(`${ok ? '✓' : '✗'} ${n}${d ? `  — ${d}` : ''}`); };

const TAG = `ZZSHIFT-${Date.now().toString(36)}`;   // unique to this run; never overlaps another
const D = (s) => new Date(`${s}T00:00:00.000Z`);
const iso = (v) => (v ? new Date(v).toISOString().slice(0, 10) : '—');

/**
 * ── THE SWEEP RUNS ON A CLEAN EXIT TOO, WHICH onTeardown DOES NOT ───────────────────────────────
 * onTeardown's registrations are invoked from the SIGTERM/SIGINT handlers in _gate-preflight and
 * from nowhere else, so a gate that simply finishes leaves its fixtures behind. Registering there
 * and walking away would have left a ZZSHIFT cost, person and vehicle on ZZ after every green run —
 * and zzSite refuses to start once ZZ holds residue, so the next gate to want a site would fail
 * somewhere else entirely. Both paths are wired: onTeardown for a signal, this for the normal end.
 */
const made = { costId: null, personId: null, vehicleId: null };
async function sweep(p) {
  if (!p) return;
  // Children cascade from these three (CostInstance/CostRate from Cost, LeaveRecord from
  // CostPerson, VehicleOdometerReading from Vehicle), so the parents are the whole sweep.
  for (const [model, id] of [['cost', made.costId], ['costPerson', made.personId], ['vehicle', made.vehicleId]]) {
    if (!id) continue;
    try { await p[model].delete({ where: { id } }); }
    catch (e) { console.log(`  sweep: ${model} ${id} not removed — ${String(e?.message ?? e).slice(0, 90)}`); }
  }
}

let prisma;
try {
  prisma = await gatePrisma();

  const site = await zzSite(prisma);

  // ── THE FIXTURE: rows whose shifted values are each other's current values ────────────────────
  // Monthly periods two months apart ARE the collision: + 2 months maps row 1 onto row 3's seat.
  const cost = await prisma.cost.create({
    data: { group_id: ZZ_GROUP, name: `${TAG} rent`, cadence: 'monthly', active_from: D('2025-08-01') },
    select: { id: true },
  });
  made.costId = cost.id;
  onTeardown(() => prisma.cost.delete({ where: { id: cost.id } }).catch(() => {}));

  const PERIODS = ['2025-08-01', '2025-09-01', '2025-10-01', '2025-11-01', '2025-12-01', '2026-01-01'];
  for (const p of PERIODS) {
    const start = D(p);
    const end = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1));
    await prisma.costInstance.create({
      data: { cost_id: cost.id, period_start: start, period_end: end, due_on: start, amount_pennies: 50000 },
    });
  }
  // Two rates exactly two months apart — the same trap on a different unique index.
  for (const p of ['2025-08-01', '2025-10-01']) {
    await prisma.costRate.create({ data: { cost_id: cost.id, effective_from: D(p), amount_pennies: 50000 } });
  }

  // LeaveRecord is keyed (cost_person_id, date) and shifts by 56 days: 2026-01-05 + 56d = 2026-03-02.
  const person = await prisma.costPerson.create({
    data: { group_id: ZZ_GROUP, name: `${TAG} tech`, cost_type: 'salary', amount_pennies: 3_000_000 },
    select: { id: true },
  });
  made.personId = person.id;
  onTeardown(() => prisma.costPerson.delete({ where: { id: person.id } }).catch(() => {}));
  for (const p of ['2026-01-05', '2026-03-02']) {
    await prisma.leaveRecord.create({
      data: { group_id: ZZ_GROUP, cost_person_id: person.id, site_id: site.id, date: D(p), type: 'annual' },
    });
  }

  // VehicleOdometerReading is keyed (vehicle_id, source, reading_date) — same 56-day trap.
  const veh = await prisma.vehicle.create({
    data: { group_id: ZZ_GROUP, registration: `${TAG}`.slice(0, 12), registration_normalized: `${TAG}`.replace(/[^A-Z0-9]/gi, '').toUpperCase().slice(0, 12) },
    select: { id: true },
  });
  made.vehicleId = veh.id;
  onTeardown(() => prisma.vehicle.delete({ where: { id: veh.id } }).catch(() => {}));
  for (const p of ['2026-01-05', '2026-03-02']) {
    await prisma.vehicleOdometerReading.create({
      data: { group_id: ZZ_GROUP, vehicle_id: veh.id, source: 'mot', reading_date: D(p), miles: 60000 },
    });
  }

  check('the fixture exists', true,
    `${PERIODS.length} cost instances, 2 rates, 2 leave days, 2 odometer readings under ${TAG}`);

  // ── THE PG_INDEX QUESTION ANSWERS THE SAME WAY ON THIS DATABASE ──────────────────────────────
  // If the derivation did not find these columns here, the proof below would be testing the
  // two-pass path on columns the real script would still move in one pass.
  const covered = await uniqueCoveredColumns(prisma, ['CostInstance', 'CostRate', 'LeaveRecord', 'VehicleOdometerReading', 'JobCard', 'Invoice']);
  for (const c of ['CostInstance.period_start', 'CostRate.effective_from', 'LeaveRecord.date', 'VehicleOdometerReading.reading_date']) {
    check(`derived as unique-covered: ${c}`, covered.has(c));
  }
  // And that it is DISCRIMINATING. A derivation that said "yes" to everything would pass the four
  // clauses above while telling us nothing.
  check('NOT flagged: CostInstance.period_end (no unique index covers it)', !covered.has('CostInstance.period_end'));
  check('NOT flagged: JobCard.start_at', !covered.has('JobCard.start_at'));
  check('NOT flagged: Invoice.issued_at', !covered.has('Invoice.issued_at'));

  const CASES = [
    { label: 'CostInstance.period_start', table: 'CostInstance', col: 'period_start', scopeSql: '"cost_id" = $1', bind: cost.id, iv: "INTERVAL '2 months'", cast: 'ts' },
    { label: 'CostRate.effective_from', table: 'CostRate', col: 'effective_from', scopeSql: '"cost_id" = $1', bind: cost.id, iv: "INTERVAL '2 months'", cast: 'ts' },
    { label: 'LeaveRecord.date', table: 'LeaveRecord', col: 'date', scopeSql: '"cost_person_id" = $1', bind: person.id, iv: "INTERVAL '56 days'", cast: 'ts' },
    { label: 'VehicleOdometerReading.reading_date', table: 'VehicleOdometerReading', col: 'reading_date', scopeSql: '"vehicle_id" = $1', bind: veh.id, iv: "INTERVAL '56 days'", cast: 'date' },
  ];

  const valuesOf = async (c) =>
    (await prisma.$queryRawUnsafe(`SELECT "${c.col}" AS v FROM "${c.table}" WHERE ${c.scopeSql} ORDER BY 1`, c.bind))
      .map((r) => iso(r.v));

  // ── RED PROOF: the OLD single-pass sql must STILL FAIL on this fixture ───────────────────────
  // Rolled back either way, so the green half below starts from the untouched fixture.
  for (const c of CASES) {
    const [single] = shiftStatements({ ...c, twoPass: false });
    let code = null, msg = '';
    try {
      await prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(single.sql, c.bind);
        throw new Error('__rollback__');          // never commit the old path, even when it works
      });
    } catch (e) {
      code = e?.meta?.code ?? e?.code ?? null;
      msg = String(e?.message ?? '');
      if (msg.includes('__rollback__')) code = 'NO_ERROR';
    }
    const collided = code === '23505' || /23505|already exists|unique constraint/i.test(msg);
    check(`RED: one UPDATE collides on ${c.label}`, collided,
      collided ? 'Postgres raised 23505 mid-statement'
        : `expected 23505, got ${code || 'nothing'}. 23505 means the fixture reproduces the bug; `
          + `42703 ("column ... does not exist") means THIS PROOF built a broken statement — check `
          + `the scopeSql spread before doubting the fixture. ${msg.slice(0, 140).replace(/\n/g, ' ')}`);
  }

  // ── GREEN: the two-pass sql succeeds, and lands the values the one-pass path intended ────────
  for (const c of CASES) {
    const before = await valuesOf(c);
    const want = (await prisma.$queryRawUnsafe(
      `SELECT ("${c.col}" + ${c.iv})${c.cast === 'date' ? '::date' : ''} AS v FROM "${c.table}" WHERE ${c.scopeSql} ORDER BY 1`, c.bind))
      .map((r) => iso(r.v));

    const stmts = shiftStatements({ ...c, twoPass: true });
    check(`${c.label} is a TWO-statement plan`, stmts.length === 2, `phases ${stmts.map((s) => s.phase).join(',')}`);

    let err = null;
    try {
      await prisma.$transaction(async (tx) => {
        for (const phase of [1, 2]) for (const s of stmts) if (s.phase === phase) await tx.$executeRawUnsafe(s.sql, c.bind);
      });
    } catch (e) { err = e; }
    check(`GREEN: two passes commit on ${c.label}`, !err, err ? describeError(err) : `${before.length} rows moved`);

    const after = await valuesOf(c);
    check(`${c.label} landed on the intended values`, JSON.stringify(after) === JSON.stringify(want),
      `want ${want.join(' ')} · got ${after.join(' ')}`);
    check(`${c.label} kept every row (no row lost to a collision)`, after.length === before.length,
      `${before.length} before, ${after.length} after`);
    // Nothing may be left parked in the 25th century — a phase 2 that silently did not run would
    // otherwise pass every clause above that only reads the row count.
    const parked = after.filter((v) => Number(v.slice(0, 4)) > 2100);
    check(`${c.label} left nothing in the parking century`, parked.length === 0, parked.join(' ') || 'none');
  }

  // ── AND THE SHIFT IS STILL A SHIFT: the gaps between rows are unchanged ──────────────────────
  // Everything above would also pass if the two passes had collapsed the rows onto one date and the
  // count happened to survive. The spacing is what makes it a translation.
  const spacing = await prisma.$queryRawUnsafe(
    `SELECT count(DISTINCT "period_start")::int AS distinct_starts, count(*)::int AS n,
            (max("period_start") - min("period_start"))::text AS span
       FROM "CostInstance" WHERE "cost_id" = $1`, cost.id);
  check('cost instances remain distinct and evenly spread', spacing[0].distinct_starts === PERIODS.length,
    `${spacing[0].distinct_starts} distinct of ${spacing[0].n}, span ${JSON.stringify(spacing[0].span)}`);
} catch (e) {
  console.log(`\n✗ the proof itself failed: ${describeError ? describeError(e) : e?.message}`);
  out.push('F');
} finally {
  await sweep(prisma);
  const fails = out.filter((c) => c === 'F').length;
  console.log(`\n${fails ? '✗' : '✓'} ${out.length - fails} of ${out.length} clauses passed${fails ? ` — ${fails} RED` : ''}`);
  if (prisma) await prisma.$disconnect().catch(() => {});
  process.exit(fails ? 1 : 0);
}
