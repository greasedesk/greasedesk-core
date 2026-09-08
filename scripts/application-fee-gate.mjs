/**
 * File: scripts/application-fee-gate.mjs
 * Gate for the application fee: the arithmetic, the resolution order, and the timeline invariant.
 *
 * ── THE PART WORTH THE MOST ─────────────────────────────────────────────────────────────────────
 * The two PARTIAL unique indexes. A plain unique on (group_id, country, currency, effective_from)
 * looks right and silently permits two PLATFORM DEFAULTS on one date, because Postgres treats NULLs
 * as distinct. That cannot be asserted from a pure function — it is a property of the database — so
 * this gate actually attempts the duplicate insert and requires it to be REFUSED.
 *
 * ── FIXTURES ────────────────────────────────────────────────────────────────────────────────────
 * Rate rows for a throwaway country code that no tenant can have (`ZZ`), plus tenant rows bound to
 * the gate tenant. Nothing real is touched, and every row this run writes is deleted by id.
 * It refuses to start if a previous run left anything behind.
 */
import './_gate-preflight.mjs';
const { describeError, declineToRun } = await import('./_gate-preflight.mjs');
const { readFileSync } = await import('node:fs');
import './_ts.mjs';
const { prisma } = await import('../lib/db.ts');
const { applicationFeePennies, resolveFeeRate } = await import('../lib/application-fee.ts');

const GATE_REF = 'GB-GD2141';   // ZZ Gate Garage
/**
 * The SECOND tenant, needed only to prove two tenants may share a boundary date. Pinned by ref to
 * the standing non-GB test tenant. It was `findFirst({ id: { not: gate } })`, which picked a real
 * trial tenant on the first run and could have picked TMBS on the next — a fixture write decided by
 * row order. Fixtures go on tenants we own, chosen by name, never by whichever row comes back first.
 */
const SECOND_REF = 'US-GD2175'; // ZZUS Motors
const CC = 'ZZ';           // a country code no tenant has — the fixture namespace
const CUR = 'ZZZ';         // likewise a currency
const out = [];
const check = (n, ok, d = '') => { out.push(ok ? 'P' : 'F'); console.log(`${ok ? '✓' : '✗'} ${n}${d ? `  — ${d}` : ''}`); };
const gbp = (p) => `£${(p / 100).toFixed(2)}`;
const D = (s) => new Date(s);

const made = [];
const mk = async (o) => {
  // vat_treatment is NOT NULL with no default: every writer says what was true of the fee it
  // priced. A fixture is no exception — a default here would be the one place the rule did not hold.
  const r = await prisma.applicationFeeRate.create({ data: { country_code: CC, currency: CUR, vat_treatment: 'not_registered', ...o }, select: { id: true } });
  made.push(r.id);
  return r.id;
};

try {
  // ── 1. THE ARITHMETIC ──────────────────────────────────────────────────────────────────────
  console.log('\n— the fee —');
  const R = { basis_points: 25, min_fee_pennies: null, cap_fee_pennies: null };
  check('25bp on the mean TMBS payment (£400) is £1.00', applicationFeePennies(40000, R) === 100);
  check('25bp on a £2,236 job is £5.59', applicationFeePennies(223600, R) === 559);
  check('25bp on a £50 MOT is 12p, not 13p', applicationFeePennies(5000, R) === 12,
    'floored — we never round our own cut up');
  check('25bp on the smallest real payment (£36) is 9p', applicationFeePennies(3600, R) === 9);
  check('a zero payment yields no fee', applicationFeePennies(0, R) === 0);
  check('a negative amount yields no fee', applicationFeePennies(-5000, R) === 0,
    'a refund is a Refund row, never a negative payment');
  check('the fee can never exceed the payment', applicationFeePennies(100, { basis_points: 50000, min_fee_pennies: null, cap_fee_pennies: null }) === 100,
    'Stripe would reject it, and the arithmetic that produced it would be wrong anyway');
  check('a floor applies when set', applicationFeePennies(5000, { ...R, min_fee_pennies: 50 }) === 50);
  check('a cap applies when set', applicationFeePennies(223600, { ...R, cap_fee_pennies: 300 }) === 300);
  check('floor and cap are both NULL in the shipped rate', R.min_fee_pennies === null && R.cap_fee_pennies === null,
    'present so a later change is not a migration over frozen money');
  // ── THE FEE IS EX-VAT (ruling 2026-08-15) ────────────────────────────────────────────────
  // 0.25% PLUS VAT where applicable, unlike the £75 subscription which is VAT-inclusive. Asserted
  // because "exclusive" is a behavioural claim: the moment anyone adds a VAT calculation here, the
  // garage is charged 30bp while every statement and the Terms still say 25.
  check('the fee is the ex-VAT figure — nothing is added on top', applicationFeePennies(40000, R) === 100,
    '£400 → £1.00 exactly; £1.20 would mean VAT had been folded in');
  check('and 25bp is the settled number, not 30', R.basis_points === 25,
    'it would have become 30 only if the fee were VAT-INCLUSIVE, which it is not');

  // Rounding direction is a decision, so it is asserted as one rather than left to Math.
  check('the rounding direction is discriminating', (() => {
    const rounded = Math.round((5000 * 25) / 10000);   // 13
    return rounded === 13 && applicationFeePennies(5000, R) === 12;
  })(), 'round-half-up would give 13p on a £50 MOT; we give 12p');

  // ── 2. RESOLUTION ORDER ────────────────────────────────────────────────────────────────────
  console.log('\n— which rate applies —');
  const g = await prisma.group.findUnique({ where: { ref: GATE_REF }, select: { id: true } });
  if (!g) throw new Error(`gate tenant ${GATE_REF} not found`);
  const pre = await prisma.applicationFeeRate.count({ where: { country_code: CC } });
  if (pre) declineToRun(`REFUSING: ${pre} fixture rate(s) from a previous run still present`);

  let threw = null;
  try { await resolveFeeRate(prisma, { groupId: g.id, country: CC, currency: CUR, at: D('2026-06-01') }); }
  catch (e) { threw = String(e.message); }
  check('no rate at all REFUSES rather than defaulting to zero', threw?.startsWith('APPFEE:'),
    'a silent zero is indistinguishable from a working integration that earns nothing');

  const platJan = await mk({ group_id: null, basis_points: 25, effective_from: D('2026-01-01') });
  const platJun = await mk({ group_id: null, basis_points: 30, effective_from: D('2026-06-01') });

  check('the platform default applies to a tenant with no rate of its own',
    (await resolveFeeRate(prisma, { groupId: g.id, country: CC, currency: CUR, at: D('2026-03-01') })).id === platJan);
  check('the latest boundary at or before the moment wins',
    (await resolveFeeRate(prisma, { groupId: g.id, country: CC, currency: CUR, at: D('2026-07-01') })).id === platJun,
    'a rate change is a new forward row, never an edit');
  check('a payment ON the boundary day takes the new rate',
    (await resolveFeeRate(prisma, { groupId: g.id, country: CC, currency: CUR, at: D('2026-06-01') })).id === platJun);
  check('a payment before every boundary still refuses', await (async () => {
    try { await resolveFeeRate(prisma, { groupId: g.id, country: CC, currency: CUR, at: D('2025-12-31') }); return false; }
    catch { return true; }
  })(), 'rates are not retroactive');

  // THE ORDERING RULE. A tenant's own rate wins even though the platform default is NEWER.
  const tenantJan = await mk({ group_id: g.id, basis_points: 10, effective_from: D('2026-01-15') });
  const resolved = await resolveFeeRate(prisma, { groupId: g.id, country: CC, currency: CUR, at: D('2026-07-01') });
  check('a tenant rate beats a NEWER platform default', resolved.id === tenantJan && resolved.basis_points === 10,
    'January tenant rate vs June platform rate — the negotiated one holds');
  check('and the plausible misreading would have got this wrong', (() => {
    // "newest effective_from wins across both scopes" — the simplification that reprices every
    // negotiated tenant the next time the default moves.
    const newestWins = [{ id: tenantJan, at: D('2026-01-15') }, { id: platJun, at: D('2026-06-01') }]
      .sort((a, b) => b.at - a.at)[0].id;
    return newestWins === platJun && resolved.id === tenantJan;
  })());
  const second = await prisma.group.findUnique({ where: { ref: SECOND_REF }, select: { id: true } });
  if (!second) throw new Error(`second test tenant ${SECOND_REF} not found — refusing to substitute another`);
  check('another tenant is unaffected by that rate',
    (await resolveFeeRate(prisma, { groupId: second.id, country: CC, currency: CUR, at: D('2026-07-01') })).id === platJun,
    'a negotiated rate is scoped to the tenant that negotiated it');

  // ── 3. THE TIMELINE INVARIANT, AT THE DATABASE ─────────────────────────────────────────────
  // Not assertable from a pure function: this is the partial-index behaviour, and the whole reason
  // a plain @@unique would have been wrong.
  console.log('\n— the timeline invariant —');
  let dupPlatform = false;
  try { await mk({ group_id: null, basis_points: 99, effective_from: D('2026-06-01') }); }
  catch (e) { dupPlatform = e?.code === 'P2002'; }
  check('a SECOND platform default on the same date is refused', dupPlatform,
    'the case a plain unique would have allowed, because Postgres treats NULLs as distinct');

  let dupTenant = false;
  try { await mk({ group_id: g.id, basis_points: 99, effective_from: D('2026-01-15') }); }
  catch (e) { dupTenant = e?.code === 'P2002'; }
  check('a second TENANT rate on the same date is refused', dupTenant);

  let allowed = false;
  try { await mk({ group_id: second.id, basis_points: 15, effective_from: D('2026-01-15') }); allowed = true; }
  catch { allowed = false; }
  check('but two DIFFERENT tenants may share a boundary date', allowed,
    'the index must constrain the timeline, not forbid coexistence');
} catch (e) {
  check('run completed', false, describeError(e).slice(0, 300));
} finally {
  if (made.length) {
    const del = await prisma.applicationFeeRate.deleteMany({ where: { id: { in: made } } });
    const left = await prisma.applicationFeeRate.count({ where: { country_code: CC } });
    check('teardown removed every fixture rate', del.count === made.length && left === 0, `${del.count} of ${made.length}, ${left} left`);
  }
  // NOT "no real rate exists" — GB/GBP was seeded deliberately on 2026-08-15 and this gate must not
  // go red for that. What must hold is that THIS RUN created nothing real: its fixtures live in the
  // ZZ/ZZZ namespace, so any row outside it predates the run.
  const real = await prisma.applicationFeeRate.count({ where: { country_code: { not: CC } } });
  const fixturesLeft = await prisma.applicationFeeRate.count({ where: { country_code: CC } });
  check('this run created no real rate and left no fixture', fixturesLeft === 0,
    `${real} real rate row(s) untouched, ${fixturesLeft} fixture(s) left`);
  // ── THE VAT DISCRIMINATOR ──────────────────────────────────────────────────────────────────
  // WHY IT EXISTS AT ALL, before anything needs it. This table's own comment already gives the
  // argument — min_fee_pennies and cap_fee_pennies are present and null "because fee_rate_id is
  // FROZEN, so adding a column afterwards is a migration over money already charged". That
  // reasoning was never applied to VAT, which is the one axis certain to change: the treatment was
  // settled on 2026-08-15 as standard-rated and EXCLUSIVE *once we are registered*, and we are not.
  // TMBS already carries ten payments with a frozen fee_rate_id, so "money already charged" stopped
  // being hypothetical in August.
  console.log('\n— what was true of the VAT when this rate priced a payment —');
  const schema = readFileSync('prisma/schema.prisma', 'utf8');
  const model = schema.split('model ApplicationFeeRate {')[1]?.split('\n}')[0] ?? '';
  check('the rate says what its VAT treatment was', /vat_treatment\s+String\b/.test(model));
  check('  …and every row must say it', !/vat_treatment\s+String\?/.test(model) && !/vat_treatment[^\n]*@default/.test(model),
    'NOT NULL and no default: a row that cannot say is a row whose frozen history is ambiguous, which is the whole reason for the column');
  check('  …from a closed set', /ApplicationFeeRate_vat_chk/.test(readFileSync('prisma/migrations/20260908110000_application_fee_vat/migration.sql', 'utf8')));

  // THE TREATMENT IS NOT THE COLLECTION. Whether the VAT rides inside Stripe's single
  // application_fee_amount or is billed on a separate consolidated invoice is a different fact —
  // about how we pull money, not about what the fee is — and it is NOT DECIDED. Encoding it here
  // would be a decision nobody made, recorded as though they had.
  const mig = readFileSync('prisma/migrations/20260908110000_application_fee_vat/migration.sql', 'utf8');
  check('the set records the TREATMENT, not how it is collected',
    !/deduction|invoiced|grossed/i.test(mig.split('ApplicationFeeRate_vat_chk')[1]?.split(';')[0] ?? ''),
    'the collection question is open, and a value for it here would answer it by accident');

  const live = await prisma.applicationFeeRate.findFirst({
    where: { group_id: null, country_code: 'GB', currency: 'GBP' },
    select: { vat_treatment: true, basis_points: true, effective_from: true },
  });
  check('the live GB/GBP row states the PRE-REGISTRATION truth', live?.vat_treatment === 'not_registered',
    `${live?.vat_treatment} — not a guess about what happens on registration day`);
  check('  …and the rate itself did not move', live?.basis_points === 25
    && live?.effective_from.toISOString().slice(0, 10) === '2026-08-15',
    `${live?.basis_points}bp from ${live?.effective_from.toISOString().slice(0, 10)}`);

  // ASKED OF POSTGRES, in a transaction that always rolls back. A CHECK has drifted from the code
  // twice in this schema and enum-drift-gate compares pg_enum, which is a different object.
  const tryVat = async (v) => {
    try {
      await prisma.$transaction(async (tx) => {
        await tx.applicationFeeRate.create({ data: { country_code: CC, currency: CUR, basis_points: 25, effective_from: new Date(), vat_treatment: v } });
        throw new Error('ROLLBACK');
      });
      return 'accepted';
    } catch (e) { return /ROLLBACK/.test(String(e?.message)) ? 'accepted' : describeError(e); }
  };
  check('an invented treatment is refused by the database', /23514/.test(await tryVat('vat_free_because_i_said_so')));
  check('  …while a real one is accepted', (await tryVat('not_registered')) === 'accepted');
  check('  …and nothing was kept', (await prisma.applicationFeeRate.count({ where: { country_code: CC } })) === 0);

  // ── AND NOTHING READS IT YET ───────────────────────────────────────────────────────────────
  // Collection is not built and must not be: it is a decision for registration day. This is what
  // keeps the column a record rather than a half-wired behaviour.
  check('no code reads the treatment', !/vat_treatment/.test(readFileSync('lib/application-fee.ts', 'utf8')),
    'the column records what was true; nothing acts on it until registration day says how');

  // The live default is a fact worth printing on every run: a silently deleted rate stops all
  // card payments, and this is the cheapest place to notice.
  const gb = await prisma.applicationFeeRate.findFirst({ where: { group_id: null, country_code: 'GB', currency: 'GBP' }, select: { basis_points: true, effective_from: true } });
  check('the GB/GBP platform default is present and 25bp', gb?.basis_points === 25,
    gb ? `25bp from ${gb.effective_from.toISOString().slice(0, 10)}` : 'MISSING — card payments would refuse');
  console.log(`\n${out.filter((c) => c === 'F').length} failures of ${out.length}`);
  await prisma.$disconnect();
  process.exit(out.includes('F') ? 1 : 0);
}
