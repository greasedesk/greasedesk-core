/**
 * scripts/commission-fixed-clock-gate.mjs
 * THE fixed-clock spec for lib/commission (platform layer 2), executable. Compiles the engine to a
 * temp dir, runs the 9 approved cases (freeze / tier boundary / trial gate / clawback states /
 * idempotency / split+handover / forecast==materialised invariant / currency / amendment×tier
 * crossing) against a fixed clock + a synthetic in-memory payment ledger, on THROWAWAY tenants
 * (synthetic country codes) it deletes on the way out. No wall-clock, no Stripe.
 *   Run:  node --env-file=.env scripts/commission-fixed-clock-gate.mjs
 */
import './_gate-preflight.mjs';
// gatePrisma() imports lib/db, which is TypeScript — the `@/` resolver has to be registered
// before it is CALLED, and this file did not need the hook while it built its own client.
import './_ts.mjs';
const { gatePrisma } = await import('./_gate-preflight.mjs');
import { execSync } from 'child_process';
import { rmSync } from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';
import { randomUUID, createHash } from 'crypto';

// Absolute temp dir at the invocation cwd (repo root) so the compile target and the dynamic import
// agree regardless of where this script file sits.
const TMP = path.resolve(process.cwd(), '.commission-gate-tmp');
try { rmSync(TMP, { recursive: true, force: true }); } catch {}
execSync(`npx tsc lib/commission.ts --outDir "${TMP}" --module es2020 --target es2020 --moduleResolution node --skipLibCheck --esModuleInterop`, { stdio: 'inherit' });
const E = await import(pathToFileURL(path.join(TMP, 'commission.js')).href);

const prisma = await gatePrisma();
const PASS = [], FAIL = [];
const chk = (n, c, x = '') => { (c ? PASS : FAIL).push(n); console.log((c ? 'PASS ' : 'FAIL ') + n + (x ? `  ${x}` : '')); };
const D = (s) => new Date(s + (s.length === 10 ? 'T00:00:00.000Z' : ''));
const created = { groups: [], countries: new Set(), runs: [], reps: [], invoices: [] };
async function mkTenant(country, activation) { const g = await prisma.group.create({ data: { group_name: 'CX ' + country, billing_email: `cx-${randomUUID()}@gd.invalid`, tax_country_code: country, trial_ends_at: activation ? D(activation) : null } }); created.groups.push(g.id); created.countries.add(country); return g.id; }
const mkRate = (country, currency, tier, eff, amt) => prisma.commissionRate.create({ data: { country_code: country, currency, tier, effective_from: D(eff), amount_pennies: amt } });
const mkAttr = (gid, pt, pid, bp, eff, ended) => prisma.tenantAttribution.create({ data: { group_id: gid, party_type: pt, party_id: pid, role: pt === 'rep' ? 'referrer' : 'regional', share_bp: bp, effective_from: D(eff), ended_at: ended ? D(ended) : null, source: 'manual' } });
const LED = {};
const addPay = (gid, ref, collected, amount, currency) => (LED[gid] ??= { p: [], r: [] }).p.push({ ref, collected_at: D(collected), amount_pennies: amount, currency });
const ledger = {
  async collectedPayments(gid, from, to) { return (LED[gid]?.p ?? []).filter((p) => p.collected_at >= from && p.collected_at < to); },
  async refunds(gid, from, to) { return (LED[gid]?.r ?? []).filter((r) => r.refunded_at >= from && r.refunded_at < to); },
  async paymentByRef(gid, ref) { return (LED[gid]?.p ?? []).find((p) => p.ref === ref) ?? null; },
};
const entriesFor = (gid, extra = {}) => prisma.commissionEntry.findMany({ where: { group_id: gid, ...extra }, orderBy: { created_at: 'asc' } });
const pay = (ref, dt, cur = 'ZP') => ({ ref, collected_at: D(dt), amount_pennies: 10000, currency: cur });

try {
  for (let i = 0; i < 6; i++) { try { await prisma.$queryRaw`SELECT 1`; break; } catch { await new Promise((r) => setTimeout(r, 2500)); } }

  chk('unit elapsedMonths 2025-02-01→2026-01-31 = 11', E.elapsedMonths(D('2025-02-01'), D('2026-01-31')) === 11);
  chk('unit elapsedMonths 2025-02-01→2026-02-01 = 12', E.elapsedMonths(D('2025-02-01'), D('2026-02-01')) === 12);

  { const c = 'Z1', g = await mkTenant(c, '2025-02-01'); const RR1 = await mkRate(c, 'ZP', 'thereafter', '2020-01-01', 3500); await mkAttr(g, 'rep', 'P1', 10000, '2025-02-01', null);
    addPay(g, 'p1', '2025-02-01', 10000, 'ZP'); await E.accruePayment(prisma, g, pay('p1', '2025-02-01'));
    const RR3 = await mkRate(c, 'ZP', 'thereafter', '2025-06-01', 4000);
    addPay(g, 'p6', '2025-07-01', 10000, 'ZP'); await E.accruePayment(prisma, g, pay('p6', '2025-07-01'));
    const e1 = (await entriesFor(g, { source_ref: 'p1' }))[0];
    chk('C1 E1 frozen at 3500 (RR1)', e1.amount_pennies === 3500 && e1.rate_id === RR1.id);
    chk('C1 recompute of closed period unchanged = 3500 (not 4000)', (await E.computeCommission(prisma, g, '2025-02', ledger)).byParty['rep:P1'] === 3500);
    const e6 = (await entriesFor(g, { source_ref: 'p6' }))[0];
    chk('C1 post-amendment payment uses new rate 4000 (RR3)', e6.amount_pennies === 4000 && e6.rate_id === RR3.id); }

  { const c = 'Z2', g = await mkTenant(c, '2025-02-01'); await mkRate(c, 'ZP', 'thereafter', '2020-01-01', 3500); await mkAttr(g, 'rep', 'P1', 10000, '2025-02-01', null);
    // THE TWELVE-MONTH BOUNDARY USED TO LIVE HERE. Commission is flat, so these four payments
    // straddle a line that no longer exists and must all be worth the same — the inverse of what
    // this case asserted, and the property the flat model actually promises.
    const cs = [['m11', '2026-01-01'], ['m11b', '2026-01-31'], ['m12', '2026-02-01'], ['m13', '2026-03-01']];
    for (const [ref, dt] of cs) await E.accruePayment(prisma, g, pay(ref, dt));
    for (const [ref, dt] of cs) { const e = (await entriesFor(g, { source_ref: ref }))[0]; chk(`C2 ${ref} (${dt}) → 3500 whatever the tenure`, e.tier === 'thereafter' && e.amount_pennies === 3500); } }

  { const c = 'Z3', g = await mkTenant(c, '2025-02-01'); await mkRate(c, 'ZP', 'thereafter', '2020-01-01', 3500); await mkAttr(g, 'rep', 'P1', 10000, '2025-02-01', null);
    await E.accruePayment(prisma, g, pay('pre', '2025-01-15')); await E.accruePayment(prisma, g, pay('act', '2025-02-01'));
    chk('C3 pre-trial payment → 0 entries', (await entriesFor(g, { source_ref: 'pre' })).length === 0);
    chk('C3 first post-activation (== trial end) → 1 entry', (await entriesFor(g, { source_ref: 'act' })).length === 1); }

  { const c = 'Z4', g = await mkTenant(c, '2025-02-01'); await mkRate(c, 'ZP', 'thereafter', '2020-01-01', 3500); await mkAttr(g, 'rep', 'P1', 10000, '2025-02-01', null);
    await E.accruePayment(prisma, g, pay('pX', '2025-03-01')); await E.clawbackRefund(prisma, g, { ref: 'rX', payment_ref: 'pX', amount_pennies: 10000, refunded_at: D('2025-03-10') }, pay('pX', '2025-03-01'));
    const netX = (await entriesFor(g, { payment_ref: 'pX' })).reduce((a, e) => a + e.amount_pennies, 0); const accX = (await entriesFor(g, { source_ref: 'pX', kind: 'accrual' }))[0];
    chk('C4a refund pre-payout: net(pX)=0, original still pending', netX === 0 && accX.status === 'pending');
    await E.accruePayment(prisma, g, pay('pY', '2025-04-01')); const accY = (await entriesFor(g, { source_ref: 'pY', kind: 'accrual' }))[0];
    // PAID NOW MEANS RELEASED-THEN-PAID. CommissionEntry_release_chk refuses a paid line with no run,
    // no released_at and no released_by — which is what this fixture used to be, and it could not
    // have happened under the model the constraint describes. So the fixture walks the real states:
    // a CLOSED throwaway run (an open one would collide with the platform-wide single-open index),
    // the line released into it, then paid.
    const runY = await prisma.repPayRun.create({ data: { period: '2025-04', scheduled_on: D('2025-04-25'),
      status: 'closed', closed_at: D('2025-04-26'), closed_by: 'fixed-clock', signoff: 'fixture run',
      snapshot_parties: 1, snapshot_line_count: 1, snapshot_amount_pennies: 3500 }, select: { id: true } });
    created.runs.push(runY.id);
    // …AND PAID NOW MEANS BILLED-THEN-PAID. CommissionEntry_invoiced_chk refuses a paid line with no
    // rep_invoice_id, because the only route to paid is a rep's invoice: released → billed onto one
    // → paid when we settle it. This fixture used to jump straight to 'paid', which under the model
    // the constraint describes never happens. Second time this fixture has been extended to walk a
    // state it was asserting from the outside — the first was release_chk, above.
    //
    // The invoice needs a real Rep (RESTRICT) and real bytes (RepInvoice_pdf_chk refuses an empty
    // buffer with a plausible hash), so it gets both rather than the minimum that would insert.
    const repY = await prisma.rep.create({ data: { email: `fixed-clock-${randomUUID()}@gd.invalid`,
      name: 'Fixed Clock Rep', ref_code: `FCG${randomUUID().slice(0, 8)}` }, select: { id: true } });
    created.reps.push(repY.id);
    const pdfY = Buffer.from('%PDF-1.7 fixture');
    const invY = await prisma.repInvoice.create({ data: {
      rep_id: repY.id, pay_run_id: runY.id, rep_invoice_number: '0001', status: 'paid',
      invoice_date: D('2025-04-26'), currency: 'ZP', subtotal_pennies: 3500, vat_applied: false,
      total_pennies: 3500, rep_trading_name_snapshot: 'Fixed Clock Rep', rep_address_snapshot: 'nowhere',
      company_name_snapshot: 'GreaseDesk Ltd', company_address_snapshot: 'Tipton', company_number_snapshot: '17312623',
      pdf: pdfY, pdf_sha256: createHash('sha256').update(pdfY).digest('hex'), pdf_bytes: pdfY.length,
      reviewed_at: D('2025-04-27'), reviewed_by: 'fixed-clock', paid_at: D('2025-04-28'),
    }, select: { id: true } });
    created.invoices.push(invY.id);
    await prisma.commissionEntry.update({ where: { id: accY.id }, data: { status: 'paid', pay_run_id: runY.id,
      released_at: D('2025-04-26'), released_by: 'fixed-clock', rep_invoice_id: invY.id } });
    await E.clawbackRefund(prisma, g, { ref: 'rY', payment_ref: 'pY', amount_pennies: 10000, refunded_at: D('2025-05-05') }, pay('pY', '2025-04-01'));
    const accY2 = await prisma.commissionEntry.findUnique({ where: { id: accY.id } }); const clawY = (await entriesFor(g, { source_ref: 'rY', kind: 'clawback' }))[0];
    chk('C4b refund post-payout: accrual stays paid (untouched), clawback pending debt -3500', accY2.status === 'paid' && clawY.status === 'pending' && clawY.amount_pennies === -3500);
    await E.accruePayment(prisma, g, pay('pZ', '2025-06-01')); await E.clawbackRefund(prisma, g, { ref: 'rZ', payment_ref: 'pZ', amount_pennies: 5000, refunded_at: D('2025-06-10') }, pay('pZ', '2025-06-01'));
    chk('C4c partial 50% refund → clawback -1750', (await entriesFor(g, { source_ref: 'rZ' }))[0].amount_pennies === -1750); }

  { const c = 'Z5', g = await mkTenant(c, '2025-02-01'); await mkRate(c, 'ZP', 'thereafter', '2020-01-01', 3500); await mkAttr(g, 'rep', 'P1', 10000, '2025-02-01', null);
    const p = pay('p5', '2025-03-01'); const r1 = await E.accruePayment(prisma, g, p); const r2 = await E.accruePayment(prisma, g, p);
    chk('C5 re-delivered accrual is a no-op (1 entry)', (await entriesFor(g, { source_ref: 'p5', kind: 'accrual' })).length === 1 && r1.written === 1 && r2.noop === 1);
    const rf = { ref: 'r5', payment_ref: 'p5', amount_pennies: 10000, refunded_at: D('2025-03-10') }; await E.clawbackRefund(prisma, g, rf, p); const cr2 = await E.clawbackRefund(prisma, g, rf, p);
    chk('C5 re-delivered clawback is a no-op (1 entry)', (await entriesFor(g, { source_ref: 'r5', kind: 'clawback' })).length === 1 && cr2.noop === 1); }

  { const c = 'Z6', g = await mkTenant(c, '2025-02-01'); await mkRate(c, 'ZP', 'thereafter', '2020-01-01', 3500); await mkAttr(g, 'rep', 'P1', 7000, '2025-02-01', null); await mkAttr(g, 'operator', 'M1', 3000, '2025-02-01', null);
    await E.accruePayment(prisma, g, pay('ps', '2025-03-01')); const es = await entriesFor(g, { source_ref: 'ps' }); const p1 = es.find((e) => e.party_id === 'P1'), m1 = es.find((e) => e.party_id === 'M1');
    chk('C6 split 70/30 of 3500 → P1 2450, M1 1050, sum 3500', p1.amount_pennies === 2450 && m1.amount_pennies === 1050);
    const gb = await mkTenant('Z6', '2025-02-01'); await mkAttr(gb, 'rep', 'PA', 6000, '2025-02-01', null); await mkAttr(gb, 'rep', 'PB', 3000, '2025-02-01', null);
    let threw = false; try { await E.accruePayment(prisma, gb, pay('pbad', '2025-03-01')); } catch (e) { threw = /sum to 9000/.test(e.message); }
    chk('C6 shares summing 9000 → THROWS, writes nothing', threw && (await entriesFor(gb)).length === 0);
    const gc = await mkTenant('Z6', '2025-02-01'); await mkAttr(gc, 'rep', 'P1', 10000, '2025-02-01', '2025-06-01'); await mkAttr(gc, 'rep', 'P2', 10000, '2025-06-01', null);
    await E.accruePayment(prisma, gc, pay('pMay', '2025-05-01')); await E.accruePayment(prisma, gc, pay('pJun', '2025-06-01'));
    const may = await entriesFor(gc, { source_ref: 'pMay' }), jun = await entriesFor(gc, { source_ref: 'pJun' });
    chk('C6 handover: May→P1 only, Jun→P2 only', may.length === 1 && may[0].party_id === 'P1' && jun.length === 1 && jun[0].party_id === 'P2'); }

  { const c = 'Z7', g = await mkTenant(c, '2025-02-01'); await mkRate(c, 'ZP', 'thereafter', '2020-01-01', 3500); await mkAttr(g, 'rep', 'P1', 7000, '2025-02-01', null); await mkAttr(g, 'operator', 'M1', 3000, '2025-02-01', null);
    addPay(g, 'p7', '2025-08-05', 10000, 'ZP'); const fc = await E.computeCommission(prisma, g, '2025-08', ledger); await E.accruePayment(prisma, g, pay('p7', '2025-08-05'));
    const mat = await entriesFor(g, { period: '2025-08' }); const byP = {}; mat.forEach((e) => byP[`${e.party_type}:${e.party_id}`] = (byP[`${e.party_type}:${e.party_id}`] || 0) + e.amount_pennies);
    chk('C7 forecast == materialised per party', JSON.stringify(fc.byParty) === JSON.stringify(byP), JSON.stringify(fc.byParty)); }

  { const c = 'Z8', g = await mkTenant(c, '2025-02-01'); await mkRate(c, 'EUR', 'thereafter', '2020-01-01', 3000); await mkAttr(g, 'rep', 'P1', 10000, '2025-02-01', null);
    await E.accruePayment(prisma, g, pay('pe', '2025-03-01', 'EUR')); const e = (await entriesFor(g, { source_ref: 'pe' }))[0];
    chk('C8 EUR tenant uses EUR rate 3000, currency EUR', e.amount_pennies === 3000 && e.currency === 'EUR');
    const gm = await mkTenant('Z8b', '2025-02-01'); await mkAttr(gm, 'rep', 'P1', 10000, '2025-02-01', null);
    // ASSERTED ON THE CODE, NOT THE PROSE. This used to match /no rate for/. On 2026-08-13 the
    // message gained one clarifying word — "no SUBSCRIPTION rate for" — and the regex stopped
    // matching, so the gate reported a silent fallback the engine never had and stayed red for
    // three days. A message is for humans; the code is the contract.
    let caught = null; try { await E.accruePayment(prisma, gm, pay('pm', '2025-03-01', 'EUR')); } catch (e) { caught = e; }
    chk('C8 missing rate → THROWS COMMISSION_NO_RATE, no silent fallback/zero',
      E.isCommissionError(caught, E.COMMISSION_ERROR.NO_RATE) && (await entriesFor(gm)).length === 0,
      caught ? `code=${caught.code}` : 'nothing thrown');
    chk('C8 the refusal carries structured grain, not just a sentence',
      caught?.detail?.country === 'Z8b' && caught?.detail?.currency === 'EUR' && caught?.detail?.tier === 'thereafter',
      JSON.stringify(caught?.detail ?? null));
    chk('C8 isCommissionError is duck-typed, so a recompiled copy still matches',
      E.isCommissionError({ code: 'COMMISSION_NO_RATE' }) === true && E.isCommissionError(new Error('x')) === false,
      'the gate imports a temp-compiled build — instanceof would be a different class object');

    // TIER GAPS WAS ASSERTED HERE, and is retired with the function: it refused a pair carrying
    // one tier and not the other, which is not a property once there is one tier. A pair either
    // has a rate or it does not, and C8 above already pins that refusal by name.
  }


  { const c = 'Z9', g = await mkTenant(c, '2025-02-01'); const RR1 = await mkRate(c, 'ZP', 'thereafter', '2020-01-01', 3500); const RR3 = await mkRate(c, 'ZP', 'thereafter', '2025-08-01', 4000); const RR4 = await mkRate(c, 'ZP', 'thereafter', '2026-01-01', 1800); await mkAttr(g, 'rep', 'P1', 10000, '2025-02-01', null);
    const cs = [['pA', '2025-05-01', 'thereafter', 3500, RR1.id], ['pB', '2025-10-01', 'thereafter', 4000, RR3.id], ['pC', '2026-02-01', 'thereafter', 1800, RR4.id], ['pD', '2026-03-01', 'thereafter', 1800, RR4.id]];
    for (const [ref, dt] of cs) { addPay(g, ref, dt, 10000, 'ZP'); await E.accruePayment(prisma, g, pay(ref, dt)); }
    for (const [ref, dt, tier, amt, rid] of cs) { const e = (await entriesFor(g, { source_ref: ref }))[0]; chk(`C9 ${ref} (${dt}) → ${tier} ${amt}`, e.tier === tier && e.amount_pennies === amt && e.rate_id === rid); }
    chk('C9 recompute of pB month later still 4000', (await E.computeCommission(prisma, g, '2025-10', ledger)).byParty['rep:P1'] === 4000); }

  console.log(`\n==== ${PASS.length} PASS, ${FAIL.length} FAIL ====`);
  if (FAIL.length) { console.log('FAILURES:\n  ' + FAIL.join('\n  ')); process.exitCode = 1; }
} catch (e) { console.error('ERR', e.message, e.stack); process.exitCode = 1; } finally {
  for (const g of created.groups) { try { await prisma.commissionEntry.deleteMany({ where: { group_id: g } }); await prisma.tenantAttribution.deleteMany({ where: { group_id: g } }); } catch {} }
  try { await prisma.commissionRate.deleteMany({ where: { country_code: { in: [...created.countries] } } }); } catch {}
  for (const g of created.groups) { try { await prisma.group.delete({ where: { id: g } }); } catch {} }
  // AFTER the entries: the pay-run FK is RESTRICT, deliberately — deleting a run that holds released
  // lines would delete the record of money somebody approved.
  // ORDER MATTERS: the entry referencing the invoice is deleted above with its group; the invoice
  // RESTRICTs the run and the rep, so it goes before both. Each by its OWN id, never by a name.
  for (const id of created.invoices) { try { await prisma.repInvoice.delete({ where: { id } }); } catch (e) { console.log('teardown invoice:', String(e).slice(0, 90)); } }
  for (const id of created.runs) { try { await prisma.repPayRun.delete({ where: { id } }); } catch (e) { console.log('teardown run:', String(e).slice(0, 90)); } }
  for (const id of created.reps) { try { await prisma.rep.delete({ where: { id } }); } catch (e) { console.log('teardown rep:', String(e).slice(0, 90)); } }
  await prisma.$disconnect(); try { rmSync(TMP, { recursive: true, force: true }); } catch {}
}
