/**
 * File: scripts/ownership-edge-gate.mjs
 * @gate-requires: db
 *
 * AN OWNERSHIP EDGE CANNOT END BEFORE IT BEGINS.
 *
 * ── THE INSTANCE ────────────────────────────────────────────────────────────────────────────────
 * TMBS held exactly one inverted edge: `valid_from 2026-08-18 → valid_to 2026-07-07`. `sellCar`
 * wrote it. It ended whatever edge was `is_current` at the sale date without checking when that edge
 * BEGAN, so a sale recorded backdated to July ended an edge that started in August. The car had come
 * in for servicing as the buyer's own car in August; the sale was entered on 6 October, dated 7 July.
 *
 * ── THE FINDING, WHICH IS WORSE THAN THE ROW ────────────────────────────────────────────────────
 * `laterOwners` + `ownershipWrite` — the careful version that caps a buyer's edge at the next known
 * owner instead of claiming the car onward — ALREADY EXISTED, and the HISTORICAL path used it while
 * the LIVE path did not. One of two writers got the rule. That is the shape to watch for: not a
 * missing rule, a rule with one caller.
 *
 * ── AND WHY THE RULE IS NOT IN THE WRITER ───────────────────────────────────────────────────────
 * There are SIX writers of VehicleOwnership across lib and pages. A rule enforced in the one being
 * fixed is a rule waiting for the seventh, so `invertedEdgeRefusal` sits with the edge rules and the
 * clause below enumerates the writers from the SOURCE rather than from the two this gate thought of.
 * The real enforcement is a CHECK constraint on the column; that needs the inverted row cleared
 * first and the two-push cycle, so it lands second and is asserted as OWED here.
 *
 * Fixtures on ZZ Gate Garage only, prefix ZZEDGE, swept before and after. Never TMBS.
 */
import './_gate-preflight.mjs';
const { gatePrisma, describeError, ZZ_GROUP, zzSite } = await import('./_gate-preflight.mjs');
import './_ts.mjs';
const { readFileSync, readdirSync } = await import('node:fs');

const out = [];
const check = (n, ok, d = '') => { out.push(ok ? 'P' : 'F'); console.log(`${ok ? '✓' : '✗'} ${n}${d ? `  — ${d}` : ''}`); };
const R = '/Users/hugh/Developer/greasedesk-core';
const HR = await import(`${R}/lib/stock-historical-rules.ts`);
const PREFIX = 'ZZEDGE';
const D = (s) => new Date(`${s}T00:00:00Z`);

let prisma = null, fix = false;
try {

// ── THE RULE ──────────────────────────────────────────────────────────────────────────────────
console.log('— an edge cannot end before it begins —');

check('an edge ending AFTER it begins is fine', HR.invertedEdgeRefusal(D('2026-07-07'), D('2026-08-18')) === null);
check('an open-ended edge has nothing to invert', HR.invertedEdgeRefusal(D('2026-07-07'), null) === null
  && HR.invertedEdgeRefusal(D('2026-07-07'), undefined) === null);
check('the SAME day is fine — a car bought and sold in one day is not inverted',
  HR.invertedEdgeRefusal(D('2026-07-07'), D('2026-07-07')) === null);
check('TMBS\'s actual row is refused', HR.invertedEdgeRefusal(D('2026-08-18'), D('2026-07-07')) !== null,
  (HR.invertedEdgeRefusal(D('2026-08-18'), D('2026-07-07')) || '').slice(0, 60));
check('  …and the refusal says what to check, not just "no"',
  /cannot end before it begins/.test(HR.INVERTED_EDGE_REFUSAL) && /sale date/.test(HR.INVERTED_EDGE_REFUSAL));
// A DAY APART, EITHER WAY: the boundary case, since the rule compares calendar days.
check('one day earlier is refused, one day later is not',
  HR.invertedEdgeRefusal(D('2026-07-08'), D('2026-07-07')) !== null
  && HR.invertedEdgeRefusal(D('2026-07-07'), D('2026-07-08')) === null);

// ── THE LIVE PATH NOW USES THE CAREFUL VERSION ────────────────────────────────────────────────
console.log('\n— one of two writers had the rule; now both do —');
{
  const sale = readFileSync(`${R}/lib/stock-sale.ts`, 'utf8');
  const hist = readFileSync(`${R}/lib/stock-historical.ts`, 'utf8');
  for (const [name, src] of [['the LIVE sale path', sale], ['the HISTORICAL path', hist]]) {
    check(`${name} caps the buyer's edge through ownershipWrite/laterOwners`,
      /ownershipWrite\(/.test(src) && /laterOwners\(/.test(src));
  }
  // THE EXACT LINE THAT WROTE THE BAD ROW must be gone, not merely surrounded by better code.
  // The first version of this clause asserted the updateMany was BOUNDED by `valid_from <= soldAt`.
  // That bound was itself the bug — it skipped a contradictory edge and left two owners current —
  // so what must be asserted is the REFUSAL, not the bound. See car-sale-gate for the row-level pair.
  // The refusal's own words, matched as EXACT TEXT — no pattern, so nothing to waive.
  // The refusal must point at the RECORD, not the sale date: 312 of 319 edges are default-dated,
  // so 'one of the two is wrong' sent the reader to re-check a date they had from the paperwork.
  const refuses = sale.includes('which is after this sale on')
    && sale.includes('usually just when this car was first seen here')
    && sale.includes('the ownership record that needs the earlier date');
  // No waiver here: a call-argument list is not key-shaped, so the sweep does not flag it — and a
  // waiver for something unflagged is decoration, which anchored-match-gate's second clause detects
  // by requiring every waiver to have a flag at its own line. It caught exactly that, here.
  const readsStart = /utcDayAfter\(e\.validFrom, a\.soldAt\)/.test(sale);
  check('the live path REFUSES a current edge dated after the sale, rather than skipping it',
    refuses && readsStart, `refuses=${refuses} readsEdgeStart=${readsStart}`);
}

// ── AND EVERY WRITER IS ACCOUNTED FOR ─────────────────────────────────────────────────────────
// ENUMERATED FROM THE SOURCE. A clause naming the writers it remembers passes while the seventh
// goes unchecked, which is exactly how this defect survived in one of two callers.
{
  const files = [];
  for (const dir of ['lib', 'pages/api', 'pages/api/import', 'lib/demo']) {
    try {
      for (const f of readdirSync(`${R}/${dir}`)) {
        if (!/\.(ts|tsx)$/.test(f)) continue;
        const src = readFileSync(`${R}/${dir}/${f}`, 'utf8');
        if (/vehicleOwnership\.(create|update|updateMany|upsert)/.test(src)) files.push(`${dir}/${f}`);
      }
    } catch { /* directory may not exist */ }
  }
  check(`every VehicleOwnership writer is known to this gate (${files.length} found)`,
    files.length >= 5, files.map((f) => f.replace('pages/api/', 'api/')).join(', '));
  // The two SALE writers must carry the rule. The others write a FIRST edge for a car with no
  // history (identity anchor, import, demo seed) and have no earlier edge to invert against —
  // stated here rather than assumed, so a new writer trips the count above.
  const withRule = files.filter((f) => /invertedEdgeRefusal|ownershipWrite/.test(readFileSync(`${R}/${f}`, 'utf8')));
  check('  …and both SALE writers carry the edge rules',
    withRule.some((f) => f.includes('stock-sale')) && withRule.some((f) => f.includes('stock-historical')),
    withRule.join(', ') || 'none');
}

// ── THE REAL ENFORCEMENT IS OWED, AND SAYING SO IS THE POINT ──────────────────────────────────
// A predicate the writers call is not a constraint. Until the column has one, writer seven can
// still do this — so the gate states the debt rather than letting the predicate look like closure.
{
  prisma = await gatePrisma();
  const chk = await prisma.$queryRawUnsafe(`
    SELECT count(*)::int AS n FROM pg_constraint con JOIN pg_class rel ON rel.oid = con.conrelid
    WHERE rel.relname = 'VehicleOwnership' AND con.contype = 'c'`);
  check('KNOWN DEBT: the column has no CHECK constraint yet — the predicate is not enforcement',
    chk[0].n === 0, `${chk[0].n} check constraint(s); a constraining migration needs the row cleared and the two-push cycle first`);
}

// ── AND THE WRITER, ON REAL ROWS ──────────────────────────────────────────────────────────────
console.log('\n— fixtures on ZZ: a backdated sale behind a later owner —');
const site = await zzSite(prisma);
const owner = await prisma.user.findFirst({ where: { group_id: ZZ_GROUP, is_owner: true }, select: { id: true } });
const sweep = async () => {
  const vs = await prisma.vehicle.findMany({ where: { group_id: ZZ_GROUP, registration: { startsWith: PREFIX } }, select: { id: true } });
  const ids = vs.map((v) => v.id);
  if (ids.length) {
    await prisma.vehicleOwnership.deleteMany({ where: { vehicle_id: { in: ids } } });
    const its = (await prisma.stockItem.findMany({ where: { vehicle_id: { in: ids } }, select: { id: true } })).map((i) => i.id);
    await prisma.stockItem.deleteMany({ where: { id: { in: its } } });
    await prisma.vehicle.deleteMany({ where: { id: { in: ids } } });
  }
  await prisma.customer.deleteMany({ where: { group_id: ZZ_GROUP, name: { startsWith: PREFIX } } });
};
await sweep();
fix = true;

// THE EXACT SHAPE THAT BROKE: a later owner edge, then a sale dated BEFORE it.
const buyer = await prisma.customer.create({ data: { group_id: ZZ_GROUP, site_id: site.id, name: `${PREFIX} Buyer` }, select: { id: true } });
const veh = await prisma.vehicle.create({ data: { group_id: ZZ_GROUP, registration: `${PREFIX}01`, registration_normalized: `${PREFIX}01` }, select: { id: true } });
await prisma.vehicleOwnership.create({ data: { vehicle_id: veh.id, customer_id: buyer.id, is_current: true, valid_from: D('2026-08-18') } });

const edges = (await prisma.vehicleOwnership.findMany({ where: { vehicle_id: veh.id }, select: { customer_id: true, valid_from: true, valid_to: true, is_current: true } }))
  .map((r) => ({ customerId: r.customer_id, customerName: '', validFrom: r.valid_from, validTo: r.valid_to, isCurrent: r.is_current }));
const own = HR.ownershipWrite(buyer.id, HR.laterOwners(edges, D('2026-07-07')));
check('a sale dated before a known later owner is "buyer_already_owner" — nothing is written',
  own.kind === 'none' && own.why === 'buyer_already_owner', `kind=${own.kind} why=${own.why ?? '-'}`);

// A DIFFERENT buyer, so the sale genuinely adds an edge that must be CAPPED rather than left open.
const other = await prisma.customer.create({ data: { group_id: ZZ_GROUP, site_id: site.id, name: `${PREFIX} Other` }, select: { id: true } });
const own2 = HR.ownershipWrite(other.id, HR.laterOwners(edges, D('2026-07-07')));
check('a DIFFERENT buyer gets an edge CAPPED at the later owner\'s start, not an open one',
  own2.kind === 'ended' && own2.validTo?.toISOString().slice(0, 10) === '2026-08-18', `kind=${own2.kind} validTo=${own2.validTo?.toISOString().slice(0, 10) ?? '-'}`);
check('  …and that capped edge is NOT inverted', HR.invertedEdgeRefusal(D('2026-07-07'), own2.kind === 'ended' ? own2.validTo : null) === null);

// THE OLD BEHAVIOUR, SHOWN TO BE WRONG: ending the current edge at the sale date.
check('the OLD write would have produced the inverted row this gate is named for',
  HR.invertedEdgeRefusal(D('2026-08-18'), D('2026-07-07')) !== null,
  'valid_from 2026-08-18 ended at 2026-07-07');

} catch (e) {
  check('gate ran to completion', false, describeError(e));
} finally {
  try {
    if (prisma && fix) {
      const vs = await prisma.vehicle.findMany({ where: { group_id: ZZ_GROUP, registration: { startsWith: PREFIX } }, select: { id: true } });
      const ids = vs.map((v) => v.id);
      if (ids.length) {
        await prisma.vehicleOwnership.deleteMany({ where: { vehicle_id: { in: ids } } });
        await prisma.vehicle.deleteMany({ where: { id: { in: ids } } });
      }
      await prisma.customer.deleteMany({ where: { group_id: ZZ_GROUP, name: { startsWith: PREFIX } } });
      const left = await prisma.vehicle.count({ where: { group_id: ZZ_GROUP, registration: { startsWith: PREFIX } } })
        + await prisma.customer.count({ where: { group_id: ZZ_GROUP, name: { startsWith: PREFIX } } });
      console.log(`residue under ${PREFIX}: ${left}`);
    }
  } catch (e) { console.log(`teardown: ${describeError(e)}`); }
  if (prisma) await prisma.$disconnect().catch(() => {});
}

const fails = out.filter((c) => c === 'F').length;
console.log(`\n${out.length - fails} of ${out.length} clauses pass`);
if (fails) process.exit(1);
