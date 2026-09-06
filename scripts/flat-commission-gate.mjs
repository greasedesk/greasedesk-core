/**
 * File: scripts/flat-commission-gate.mjs
 * £30 A MONTH FOR AS LONG AS THE GARAGE IS A CUSTOMER — no taper, no tenure.
 * @gate-requires: db
 *
 * ── WHAT CHANGED ────────────────────────────────────────────────────────────────────────────────
 * The engine was built for a tapering model: £35 then £30 for the first twelve payments, £12.50
 * thereafter, with tierForTenure deciding which applied from the tenant's activation date. The
 * commission model is now flat — the same amount in month one and month sixty — so the tier is no
 * longer a thing to DERIVE. A rate is resolved by date alone.
 *
 * The `tier` COLUMN stays. CommissionEntry.tier is part of a frozen money record and the two
 * historical CommissionRate rows genuinely carried those values; deleting the column would rewrite
 * what was true. What goes is the derivation, the twelve-month boundary, and tierGaps — a check
 * that a country carried BOTH tiers, which is meaningless once there is one.
 *
 * ── AND THE VISIT GATE'S HALF OF THE RATE ───────────────────────────────────────────────────────
 * Commission is about to become visit-gated: the full amount when the month's visit happened, a
 * reduced one when it did not. That reduced amount belongs on the same dated, frozen timeline as
 * the full one — what the reduced rate WAS in March must not move either — so it is a column on
 * CommissionRate, not a percentage applied at payout.
 *
 * NULLABLE, and the two frozen rows are NULL. That is not an unfilled field: there was no such
 * concept when they were written, and a payout that meets one must refuse rather than invent a
 * figure — the same honest-null discipline resolveRate already applies when no rate exists.
 *
 * ── NO WALL-CLOCK IN THE ASSERTIONS ─────────────────────────────────────────────────────────────
 * Rates are resolved by `collected_at`, so every check here names an explicit instant. A gate that
 * asked "what is the rate now" would change answer on the day a forward amendment lands.
 *
 * Fixtures on ZZ Gate Garage only. Never TMBS — and never a rate row: the timeline is production
 * money config, so this gate READS it and writes only a rep + attribution it deletes.
 */
import './_gate-preflight.mjs';
const { gatePrisma, describeError } = await import('./_gate-preflight.mjs');
import './_ts.mjs';
const { readFileSync } = await import('node:fs');
const E = await import('../lib/commission.ts').catch((e) => ({ __err: String(e) }));
const prisma = await gatePrisma();

const ZZ = 'c75ac44e-250a-4c90-98ba-a8326e98dad5';
const FLAT = 3000;          // £30.00
const out = [];
const check = (n, ok, d = '') => { out.push(ok ? 'P' : 'F'); console.log(`${ok ? '✓' : '✗'} ${n}${d ? `  — ${d}` : ''}`); };
const code = (f) => readFileSync(f, 'utf8').split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
const M = (p) => (p == null ? 'null' : `£${(p / 100).toFixed(2)}`);
let fix = null;

try {
  // ── 1. THE DERIVATION IS GONE ────────────────────────────────────────────────────────────────
  console.log('\n— a rate is resolved by date, not by how long they have been a customer —');
  check('tierForTenure is retired', typeof E.tierForTenure !== 'function', typeof E.tierForTenure);
  check('the twelve-month boundary is retired', E.TIER_BOUNDARY_MONTHS === undefined, String(E.TIER_BOUNDARY_MONTHS));
  check('tierGaps is retired', typeof E.tierGaps !== 'function',
    'it asserted a country carried BOTH tiers, which is meaningless with one');
  const src = code('lib/commission.ts');
  check('  …and nothing still derives a tier from tenure',
    !/elapsedMonths\([^)]*\)\s*<\s*TIER_BOUNDARY|tierForTenure/.test(src));
  // elapsedMonths itself STAYS: it is pure date maths and the visit rules will want it.
  check('  …while elapsedMonths, which is just date maths, remains', typeof E.elapsedMonths === 'function');
  const screen = code('pages/superadmin/rates.tsx');
  check('the Rates screen no longer surfaces a tier gap', !/tierGaps/.test(screen));

  // ── 2. THE REDUCED RATE IS ON THE SAME TIMELINE ──────────────────────────────────────────────
  console.log('\n— the reduced rate is dated and frozen, like the full one —');
  const schema = readFileSync('prisma/schema.prisma', 'utf8');
  const model = /^model CommissionRate \{([\s\S]*?)^\}/m.exec(schema)?.[1] ?? '';
  check('CommissionRate carries amount_unvisited_pennies', /amount_unvisited_pennies\s+Int\?/.test(model),
    'nullable: the frozen rows predate the concept and must not be given an invented figure');

  // ── 3. THE LIVE TIMELINE ─────────────────────────────────────────────────────────────────────
  const rates = await prisma.commissionRate.findMany({
    where: { revenue_stream: 'subscription', country_code: 'GB', currency: 'GBP' },
    orderBy: { effective_from: 'asc' },
  });
  const frozen = rates.filter((r) => r.effective_from < new Date('2026-09-06'));
  check('the three frozen rows are untouched', frozen.length === 3
    && frozen.every((r) => r.amount_unvisited_pennies === null),
    frozen.map((r) => `${r.tier} ${M(r.amount_pennies)} unvisited=${M(r.amount_unvisited_pennies)}`).join(' | '));
  check('  …including the £12.50 taper row, which was real and stays', 
    frozen.some((r) => r.tier === 'thereafter' && r.amount_pennies === 1250),
    'history is frozen; the amendment is forward');

  // ── 4. WHAT A PAYMENT RESOLVES, AT AN EXPLICIT INSTANT ───────────────────────────────────────
  console.log('\n— and the same amount whether they joined last month or two years ago —');
  const rep = await prisma.rep.create({
    data: { email: 'zz-flat-gate@greasedesk.test', passwordHash: 'x', name: 'Flat Gate',
      ref_code: 'ZZFLATGATE', country_code: 'GB' }, select: { id: true },
  });
  const attr = await prisma.tenantAttribution.create({
    data: { group_id: ZZ, party_type: 'rep', party_id: rep.id, role: 'referrer', share_bp: 10000,
      effective_from: new Date('2020-01-01'), source: 'manual' }, select: { id: true },
  });
  fix = { repId: rep.id, attrId: attr.id };

  const AT = new Date('2026-09-30T12:00:00Z');
  const pay = (ref) => ({ ref, collected_at: AT, amount_pennies: 7500, currency: 'GBP' });
  const linesFor = async (activation) => {
    try {
      return await E.linesForPayment(prisma, { groupId: ZZ, activation, country: 'GB' }, pay(`gate-${+activation}`));
    } catch (e) { return { __err: e?.code ?? describeError(e) }; }
  };
  const fresh = await linesFor(new Date('2026-09-01T00:00:00Z'));  // a month in
  const old = await linesFor(new Date('2023-01-01T00:00:00Z'));    // nearly four years in
  check('a garage one month in is worth £30', Array.isArray(fresh) && fresh[0]?.amount_pennies === FLAT,
    JSON.stringify(fresh).slice(0, 160));
  check('a garage four years in is worth £30 too', Array.isArray(old) && old[0]?.amount_pennies === FLAT,
    JSON.stringify(old).slice(0, 160));
  // THE DISCRIMINATING HALF: if both were simply erroring, or both zero, the pair above proves nothing.
  check('  …and that is the SAME rate row, not two that happen to match',
    Array.isArray(fresh) && Array.isArray(old) && fresh[0]?.rate_id === old[0]?.rate_id,
    `${fresh[0]?.rate_id?.slice(0, 8)} vs ${old[0]?.rate_id?.slice(0, 8)} — one timeline, resolved by date alone`);
  check('  …carrying the reduced amount for a month with no visit',
    (rates.find((r) => r.id === fresh[0]?.rate_id)?.amount_unvisited_pennies ?? null) !== null,
    M(rates.find((r) => r.id === fresh[0]?.rate_id)?.amount_unvisited_pennies));

  // ── 5. THE WRITE SURFACE OFFERS ONE TIER ─────────────────────────────────────────────────────
  console.log('\n— and nobody can add a rate the engine will never ask for —');
  const api = code('pages/api/superadmin/rates.ts');
  check('the rates API accepts one tier value', /ONGOING_TIER/.test(api),
    'adding a first_12m rate would write a row nothing resolves');
  check('  …and the engine asks for that same one', /ONGOING_TIER/.test(src));
} catch (e) {
  check('gate run completed', false, describeError(e).slice(0, 300));
} finally {
  if (fix) {
    try {
      if (fix.attrId) await prisma.tenantAttribution.delete({ where: { id: fix.attrId } });
      if (fix.repId) await prisma.rep.delete({ where: { id: fix.repId } });
    } catch (e) { console.log(`  teardown: ${describeError(e).slice(0, 120)}`); }
    check('teardown removed the fixture rep and attribution',
      (await prisma.rep.count({ where: { id: fix.repId } })) === 0
      && (await prisma.tenantAttribution.count({ where: { id: fix.attrId } })) === 0);
  }
  check('no rate row was created by this gate',
    (await prisma.commissionRate.count({ where: { created_by: null } })) === 0,
    'the timeline is production money config — this gate reads it');
}

console.log(`\n${out.filter((x) => x === 'F').length} failures of ${out.length}`);
await prisma.$disconnect();
process.exit(out.includes('F') ? 1 : 0);
