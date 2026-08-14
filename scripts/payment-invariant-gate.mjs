/**
 * File: scripts/payment-invariant-gate.mjs
 * STANDING GATE. Does the payment ledger still say what the invoices claim?
 *
 * Run it after anything that touches money, and before and after the backfill. READ-ONLY: it
 * creates nothing, so it can be run against production at any time without ceremony.
 *
 * ── WHAT IT IS ACTUALLY GUARDING ────────────────────────────────────────────────────────────────
 * amount_paid_pennies became a CACHE of the Payment rows. The failure mode of a cache is not a
 * wrong sum — the arithmetic is one exported function — it is a writer that updates one side and
 * not the other: a Payment row written where the invoice update then failed, or the reverse. Both
 * live inside a $transaction today, so the two commit or roll back together. This is what proves
 * that stays true after the next person adds a fifth door.
 *
 * ── RULE 1: FAILURE IS PROVED AGAINST THE PURE FUNCTION ─────────────────────────────────────────
 * expectedCachePennies is exported from lib/payments and imported here, so the gate checks the REAL
 * rule. A gate that reimplements the arithmetic only ever proves it agrees with itself. The
 * deliberately-broken variant below shows the assertions discriminate, with no database and no
 * blast radius.
 */
import { prisma } from '../lib/db.ts';
import { expectedCachePennies } from '../lib/payments.ts';

const out = [];
const check = (n, ok, d = '') => { out.push(ok ? 'P' : 'F'); console.log(`${ok ? '✓' : '✗'} ${n}${d ? `  — ${d}` : ''}`); };
const gbp = (p) => (p == null ? 'unknown' : `£${(p / 100).toFixed(2)}`);
const S = (n) => ({ status: 'succeeded', amount_pennies: n });
const P = (n) => ({ status: 'processing', amount_pennies: n });
const X = (n) => ({ status: 'canceled', amount_pennies: n });

// ── RULE 1: the rule, and a broken copy of it, with no database ────────────────────────────────
check('no ledger rows → UNKNOWN, not zero', expectedCachePennies([], []) === null);
check('rows but nothing cleared → 0, which is not unknown', expectedCachePennies([P(12000)], []) === 0);
check('a succeeded payment counts', expectedCachePennies([S(12000)], []) === 12000);
check('a cancelled payment never counts', expectedCachePennies([X(12000)], []) === 0);
check('part payments add up', expectedCachePennies([S(12000), S(5126)], []) === 17126);
check('a refund comes back off', expectedCachePennies([S(12000)], [{ amount_pennies: 3000 }]) === 9000);
check('an over-refund goes NEGATIVE rather than clamping to zero',
  expectedCachePennies([S(12000)], [{ amount_pennies: 15000 }]) === -3000, 'a refund owed is a real state');
{
  // The bug that matters: treating "pending" as received. It makes the debtors figure optimistic by
  // exactly the amount most likely never to arrive.
  const BROKEN = (ps, rs) => (ps.length === 0 ? null : ps.reduce((a, p) => a + p.amount_pennies, 0) - rs.reduce((a, r) => a + r.amount_pennies, 0));
  check('RULE 1 — the assertions would CATCH a rule that counted pending money',
    BROKEN([P(12000)], []) === 12000 && expectedCachePennies([P(12000)], []) === 0,
    'broken says £120.00 received, real says £0.00 — proved without touching a row');
}

// ── THE LEDGER, ACROSS EVERY TENANT ────────────────────────────────────────────────────────────
try {
  const invoices = await prisma.invoice.findMany({
    select: { id: true, invoice_number: true, amount_paid_pennies: true, status: true,
              group: { select: { ref: true, is_demo: true } } },
  });
  const payments = await prisma.payment.findMany({
    select: { id: true, invoice_id: true, status: true, amount_pennies: true, provider: true, reconstructed: true, currency: true, source_ref: true },
  });
  const refunds = await prisma.refund.findMany({ select: { payment_id: true, amount_pennies: true } });

  const byInvoice = new Map();
  for (const p of payments) { const a = byInvoice.get(p.invoice_id) ?? []; a.push(p); byInvoice.set(p.invoice_id, a); }
  const refByPayment = new Map();
  for (const r of refunds) { const a = refByPayment.get(r.payment_id) ?? []; a.push(r); refByPayment.set(r.payment_id, a); }

  const drift = [];        // cache disagrees with its own ledger
  const cacheNoLedger = [];// a figure with nothing behind it
  for (const inv of invoices) {
    const ps = byInvoice.get(inv.id) ?? [];
    const rs = ps.flatMap((p) => refByPayment.get(p.id) ?? []);
    const expected = expectedCachePennies(ps, rs);
    if (ps.length === 0) { if (inv.amount_paid_pennies != null) cacheNoLedger.push(inv); continue; }
    if (inv.amount_paid_pennies !== expected) {
      drift.push(`${inv.group.ref}/${inv.invoice_number}: cache ${gbp(inv.amount_paid_pennies)} vs ledger ${gbp(expected)}`);
    }
  }

  console.log(`\n   ${invoices.length} invoices · ${payments.length} payment rows · ${refunds.length} refunds\n`);
  check('THE INVARIANT: every invoice with a ledger matches it', drift.length === 0, drift.slice(0, 5).join(' | ') || 'no drift');

  // Expected to be non-zero ONLY until the backfill runs. Reported as a count, not a failure, so the
  // gate is usable on both sides of step 5 — and asserted to be zero once any ledger exists.
  console.log(`   invoices with a cached amount and NO ledger row: ${cacheNoLedger.length}${cacheNoLedger.length ? '  (pre-backfill — expected)' : ''}`);
  if (payments.length > 0) {
    check('once the ledger exists, nothing should carry a figure without one',
      cacheNoLedger.length === 0 || process.env.ALLOW_PRE_BACKFILL === '1',
      `${cacheNoLedger.length} such invoices — set ALLOW_PRE_BACKFILL=1 while step 5 is outstanding`);
  }

  // ── ROW-LEVEL SANITY ─────────────────────────────────────────────────────────────────────────
  check('no payment has a negative or zero amount', !payments.some((p) => p.amount_pennies <= 0),
    payments.filter((p) => p.amount_pennies <= 0).length + ' bad');
  check('no refund has a negative or zero amount', !refunds.some((r) => r.amount_pennies <= 0));
  check('every payment status is one we know',
    payments.every((p) => ['succeeded', 'processing', 'canceled', 'failed', 'requires_action'].includes(p.status)),
    [...new Set(payments.map((p) => p.status))].join(', ') || 'none yet');
  check('every provider is one we know', payments.every((p) => ['manual', 'stripe'].includes(p.provider)),
    [...new Set(payments.map((p) => p.provider))].join(', ') || 'none yet');
  check('no refund exceeds the payment it belongs to', (() => {
    for (const [pid, rs] of refByPayment) {
      const p = payments.find((x) => x.id === pid);
      if (p && rs.reduce((a, r) => a + r.amount_pennies, 0) > p.amount_pennies) return false;
    }
    return true;
  })());
  // A reconstructed row is a defensible inference; an OBSERVED row that is secretly reconstructed
  // is not. The two must stay distinguishable, so the flag and the key have to agree.
  // The flag and the key must AGREE in both directions. The first version of this check did not
  // select source_ref, so every row compared against `undefined` and the assertion passed on
  // nothing — the same vacuous-pass shape as "every warranty invoice is settled" on zero warranties.
  check('reconstructed rows are labelled AND keyed as such, both ways',
    payments.every((p) => p.reconstructed === String(p.source_ref ?? '').startsWith('backfill:')),
    `${payments.filter((p) => p.reconstructed).length} reconstructed of ${payments.length}`);
  check('no demo-tenant payment row exists while the demo is frozen',
    !payments.some((p) => invoices.find((i) => i.id === p.invoice_id)?.group.is_demo),
    'demo tenants carry no ledger');
} catch (e) {
  check('run completed', false, String(e?.message ?? e).slice(0, 200));
} finally {
  console.log(`\n${out.filter((c) => c === 'F').length} failures of ${out.length}`);
  await prisma.$disconnect();
  process.exit(out.includes('F') ? 1 : 0);
}
