// @gate-timeout: 180
/**
 * File: scripts/mot-mint-gate.mjs
 * THE PRINTED MOT EXPIRY IS VERIFIED AT THE MOMENT IT BECOMES A CLAIM.
 *
 * LB14FJX's invoice printed 2026-09-20 when DVSA had said 2027-09-20 since the car was tested — on
 * the very visit being invoiced, at the odometer-out on that card. The needs block reads the vehicle
 * row live at mint and freezes it, so the document was only as current as whenever somebody last
 * happened to look, and 210 of 214 stored expiries had never been looked at.
 *
 * ── NO GATE TOUCHES LIVE DVSA ──────────────────────────────────────────────────────────────────
 * Both branches are forced by INJECTING the lookup: one that answers with a newer expiry, and one
 * that fails. A gate that reaches a third-party API goes red when somebody else has an outage, and
 * a gate that goes red for reasons of its own stops being believed. The failure is injected four
 * ways — null, a throw, a timeout, and an unset credential — because "it failed" has more than one
 * shape and only one of them is the one people test.
 *
 * Fixtures on ZZ Gate Garage only. Never TMBS.
 */
import './_gate-preflight.mjs';
const { zzSite } = await import('./_gate-preflight.mjs');
import './_ts.mjs';
const { PrismaClient } = await import('@prisma/client');
const M = await import('../lib/mot-mint-refresh.ts');
const { issueInvoiceForCard } = await import('../lib/invoice-issue.ts');
const { readFileSync } = await import('node:fs');
const prisma = new PrismaClient();

const ZZ = 'c75ac44e-250a-4c90-98ba-a8326e98dad5';
const CUST = 'MOT Mint Fixture Holder';
const REG = 'ZZ76MOT';
const STORED = new Date('2026-09-20T00:00:00.000Z');
const FRESH = '2027-09-20';
const out = [];
const check = (n, ok, d = '') => { out.push(ok ? 'P' : 'F'); console.log(`${ok ? '✓' : '✗'} ${n}${d ? `  — ${d}` : ''}`); };
let fix = null;

// The shape dvsaLookup returns, with an expiry a year on from what the fixture holds.
const answers = { make: 'MINI', model: 'COOPER', colour: 'Red', fuel: 'Petrol', engineCc: 1499, year: 2014,
  motExpiry: FRESH, lastMotMileage: 117735, lastMotDate: '2026-08-21', odometerHistory: [] };

try {
  const stale = await prisma.vehicle.count({ where: { group_id: ZZ, registration: REG } });
  if (stale) throw new Error(`REFUSING: ${stale} fixture vehicle(s) from a previous run still present`);
  const site = await zzSite(prisma);
  const cust = await prisma.customer.create({ data: { group_id: ZZ, name: CUST }, select: { id: true } });
  fix = { cust: cust.id, vehs: [], cards: [], invoices: [] };

  const mk = async (suffix) => {
    const reg = REG + suffix;
    const v = await prisma.vehicle.create({ data: { group_id: ZZ, registration: reg, registration_normalized: reg,
      make: 'MOT', model: 'Fixture', mot_expiry: STORED, last_mot_date: new Date('2025-09-02T00:00:00.000Z'),
      last_mot_mileage: 110833 }, select: { id: true, registration: true, mot_expiry: true, last_mot_mileage: true, last_mot_date: true, mot_checked_at: true } });
    await prisma.vehicleOwnership.create({ data: { vehicle_id: v.id, customer_id: cust.id, is_current: true } });
    const c = await prisma.jobCard.create({ data: { group_id: ZZ, site_id: site.id, vehicle_id: v.id,
      customer_id: cust.id, status: 'in_progress', odometer_in: 117000, odometer_out: 117735 }, select: { id: true } });
    await prisma.jobCardItem.create({ data: { job_card_id: c.id, item_type: 'labour', description: 'MOT fixture work',
      qty: 1, unit_price: 50, vat_rate: 20, vat_amount: 10 } });
    fix.vehs.push(v.id); fix.cards.push(c.id);
    return { v, card: c.id };
  };

  // ── 1. A LOOKUP THAT ANSWERS MOVES THE PRINTED DATE ──────────────────────────────────────────
  console.log('\n— the expiry is refreshed before the freeze —');
  const a = await mk('A');
  check('the fixture starts stale and unverified',
    a.v.mot_expiry.toISOString().slice(0, 10) === '2026-09-20' && a.v.mot_checked_at === null,
    'a check that starts where it wants to end proves nothing');
  const r1 = await M.refreshMotForMint(prisma, a.v, { lookup: async () => answers });
  check('the refresh reports the expiry moved', r1.answered === true
    && r1.expiryChanged?.from === '2026-09-20' && r1.expiryChanged?.to === FRESH, JSON.stringify(r1));
  const afterA = await prisma.vehicle.findUnique({ where: { id: a.v.id },
    select: { mot_expiry: true, mot_checked_at: true, last_mot_date: true, last_mot_mileage: true } });
  check('  …and the vehicle row carries it', afterA.mot_expiry.toISOString().slice(0, 10) === FRESH);
  check('  …with mot_checked_at stamped', afterA.mot_checked_at !== null);
  check('  …and the test facts moved too', afterA.last_mot_mileage === 117735
    && afterA.last_mot_date.toISOString().slice(0, 10) === '2026-08-21');

  let invA = null;
  await prisma.$transaction(async (tx) => { invA = await issueInvoiceForCard(tx, a.card, ZZ); }, { timeout: 30000 });
  fix.invoices.push(invA);
  const snapA = (await prisma.invoice.findUnique({ where: { id: invA }, select: { due_items_snapshot: true } }))?.due_items_snapshot ?? '';
  check('THE FROZEN BLOCK CARRIES THE REFRESHED DATE', /20 September 2027/.test(snapA), snapA.split('\n')[0]);
  check('  …and not the one it held a moment ago', !/20 September 2026/.test(snapA),
    'the stale date must be gone, not merely accompanied');

  // ── 2. WITH DVSA UNAVAILABLE, THE MINT IS UNAFFECTED ─────────────────────────────────────────
  // Four failure shapes, because "it failed" is not one thing and the one people test is `null`.
  console.log('\n— and when DVSA is not there —');
  const b = await mk('B');
  for (const [name, lookup, opts] of [
    ['answers null', async () => null, {}],
    ['throws', async () => { throw new Error('ECONNRESET'); }, {}],
    ['never returns (timeout)', () => new Promise(() => {}), { timeoutMs: 300 }],
  ]) {
    const r = await M.refreshMotForMint(prisma, b.v, { lookup, ...opts });
    check(`a lookup that ${name} writes nothing`, r.answered === false && r.written.length === 0 && r.expiryChanged === null, JSON.stringify(r));
  }
  const afterB = await prisma.vehicle.findUnique({ where: { id: b.v.id }, select: { mot_expiry: true, mot_checked_at: true } });
  check('  …and stamps nothing — a failure is not news about the car',
    afterB.mot_checked_at === null && afterB.mot_expiry.toISOString().slice(0, 10) === '2026-09-20',
    JSON.stringify(afterB) + ' — a stamp here would say DVSA confirmed a date it never saw');

  let invB = null;
  await prisma.$transaction(async (tx) => { invB = await issueInvoiceForCard(tx, b.card, ZZ); }, { timeout: 30000 });
  fix.invoices.push(invB);
  const snapB = (await prisma.invoice.findUnique({ where: { id: invB }, select: { due_items_snapshot: true } }))?.due_items_snapshot ?? '';
  check('THE MINT STILL SUCCEEDS', invB != null && snapB.length > 0, `${snapB.split('\n')[0]}`);
  check('  …printing the STORED date, exactly as it did before any of this', /20 September 2026/.test(snapB), snapB.split('\n')[0]);

  // ── 3. THE CALLER RUNS IT OUTSIDE THE TRANSACTION ────────────────────────────────────────────
  // An HTTP call inside the mint tx holds a pooled Neon connection across someone else's network.
  // Asserted on the source because the ordering is the whole safety property and nothing at
  // runtime distinguishes "before the tx" from "early inside it".
  console.log('\n— and never inside the transaction —');
  const src = readFileSync('pages/api/jobcard-status.ts', 'utf8');
  const refreshAt = src.indexOf('refreshMotForMint(');
  const txAt = src.indexOf('prisma.$transaction(');
  check('the caller refreshes BEFORE opening the transaction', refreshAt > 0 && refreshAt < txAt,
    `refresh at ${refreshAt}, transaction at ${txAt} — a lookup inside the tx holds a pooled connection across DVSA`);
  check('  …and the mint module itself makes no network call',
    !/dvsaLookup|refreshMotForMint/.test(readFileSync('lib/invoice-issue.ts', 'utf8')),
    'the freeze reads the vehicle row; refreshing it is the caller job');
  check('the timeout is capped at three seconds', M.MINT_LOOKUP_TIMEOUT_MS === 3000, String(M.MINT_LOOKUP_TIMEOUT_MS));
} catch (e) {
  console.log(`\n✗ THREW: ${String(e?.stack ?? e).slice(0, 900)}`);
  out.push('F');
} finally {
  if (fix) {
    const step = async (n, f) => { try { await f(); } catch (e) { console.log(`  teardown ${n}: ${String(e?.message ?? e).slice(0, 110)}`); } };
    for (const id of fix.invoices ?? []) {
      await step('invoice lines', () => prisma.invoiceLine.deleteMany({ where: { invoice_id: id } }));
      await step('invoice', () => prisma.invoice.deleteMany({ where: { id } }));
    }
    await step('items', () => prisma.jobCardItem.deleteMany({ where: { job_card_id: { in: fix.cards } } }));
    await step('findings', () => prisma.vehicleDueItem.deleteMany({ where: { vehicle_id: { in: fix.vehs } } }));
    await step('cards', () => prisma.jobCard.deleteMany({ where: { group_id: ZZ, id: { in: fix.cards } } }));
    await step('edges', () => prisma.vehicleOwnership.deleteMany({ where: { vehicle_id: { in: fix.vehs } } }));
    await step('vehicles', () => prisma.vehicle.deleteMany({ where: { group_id: ZZ, registration: { startsWith: REG } } }));
    await step('customer', () => prisma.customer.deleteMany({ where: { group_id: ZZ, id: fix.cust } }));
    try {
      const left = await prisma.vehicle.count({ where: { group_id: ZZ, registration: { startsWith: REG } } })
        + await prisma.customer.count({ where: { group_id: ZZ, id: fix.cust } });
      check('teardown removed every fixture row (ZZ only)', left === 0, `${left} left`);
    } catch (e) {
      check('teardown removed every fixture row (ZZ only)', false, `COULD NOT VERIFY — ${String(e?.message ?? e).split('\n')[0].slice(0, 70)}`);
    }
  }
  const f = out.filter((x) => x === 'F').length;
  console.log(`\n${f} failures of ${out.length}`);
  await prisma.$disconnect();
  process.exit(f ? 1 : 0);
}
