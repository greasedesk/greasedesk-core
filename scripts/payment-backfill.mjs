/**
 * File: scripts/payment-backfill.mjs
 * Reconstruct Payment rows for invoices marked paid BEFORE the payment ledger existed.
 *
 *   node --experimental-strip-types --import ./scripts/_ts.mjs scripts/payment-backfill.mjs --group=GB-GD2141
 *   …same, plus --apply   to write
 *
 * DRY RUN BY DEFAULT. --apply is the only thing that writes, and a tenant ref is always required:
 * there is no "all tenants" mode, because the one thing this must never do is sweep further than
 * the person running it intended.
 *
 * ── WHAT A RECONSTRUCTED ROW CLAIMS, AND WHAT IT DOESN'T ────────────────────────────────────────
 * The amount is ENTAILED, not observed: before this table, "paid" meant paid in full, because
 * partial payment did not exist as a concept. That inference is defensible — and it is exactly why
 * every row is keyed `backfill:<invoice_id>` and carries reconstructed = true. Nobody typed these
 * figures, and in three years a row that cannot say so becomes a quiet fabrication. The flag is
 * derived from the key inside recordPayment, so the two cannot disagree.
 *
 * ── WHAT IS DELIBERATELY LEFT ALONE ─────────────────────────────────────────────────────────────
 *   paid_pending  money recorded but inside a clearance window. Reconstructing these as
 *                 `processing` would hand live rows to settleProcessing mid-flight and change what
 *                 the clearance cron does to invoices already in progress. Their cache stays NULL,
 *                 which is honest: we do not know that the money arrived.
 *   settled       the WARRANTY terminal status. £0.00 by construction — no money ever moved, and a
 *                 payment row would invent one.
 *   void / issued nothing was received.
 *   no paid date  `date_paid ?? paid_at` both NULL. A payment needs a date, and guessing one moves
 *                 money between VAT quarters. Reported, never invented.
 *   zero total    nothing to reconstruct.
 *   already has a Payment row — real or reconstructed. Idempotent by construction as well: the
 *                 unique source_ref makes a second run a no-op, but skipping early keeps the
 *                 output honest about what is left to do.
 *
 * DEMO TENANTS ARE REFUSED OUTRIGHT. Nothing in one is real, and the reference demo is frozen.
 */
import { prisma } from '../lib/db.ts';
import { invoiceTotals, effectivePaidDate } from '../lib/invoice.ts';
import { recordPayment } from '../lib/payments.ts';

const arg = (n) => process.argv.find((a) => a.startsWith(`--${n}=`))?.split('=')[1];
const APPLY = process.argv.includes('--apply');
const REF = arg('group');

if (!REF) {
  console.error('REFUSING: --group=<ref> is required. There is no all-tenants mode.');
  process.exit(1);
}

const gbp = (p) => `£${(p / 100).toFixed(2)}`;
const pad = (s, n) => String(s).padEnd(n);

try {
  const g = await prisma.group.findUnique({
    where: { ref: REF },
    select: { id: true, ref: true, group_name: true, is_demo: true, is_internal: true },
  });
  if (!g) throw new Error(`no tenant with ref ${REF}`);
  if (g.is_demo) throw new Error(`${REF} is a DEMO tenant — nothing in it is real and the reference demo is frozen`);

  console.log(`\n${g.group_name} (${g.ref})${g.is_internal ? '  [internal]' : ''}   ${APPLY ? 'APPLY' : 'DRY RUN'}`);
  console.log('─'.repeat(78));

  const invoices = await prisma.invoice.findMany({
    where: { group_id: g.id },
    select: {
      id: true, invoice_number: true, status: true, series: true, site_id: true,
      paid_at: true, date_paid: true, vat_registered_at_issue: true,
      payment_method_id: true, payment_method_snapshot: true, amount_paid_pennies: true,
      lines: { select: { vat_rate: true, line_total: true, line_vat: true } },
      site: { select: { currency_code: true } },
      _count: { select: { payments: true } },
    },
    orderBy: { issued_at: 'asc' },
  });

  const skips = new Map();
  const skip = (why, inv) => {
    if (!skips.has(why)) skips.set(why, []);
    skips.get(why).push(inv.invoice_number ?? inv.id.slice(0, 8));
  };

  const todo = [];
  const divergent = [];
  for (const inv of invoices) {
    if (inv._count.payments > 0) { skip('already has a ledger row', inv); continue; }
    if (inv.status !== 'paid') { skip(`status is "${inv.status}"`, inv); continue; }
    if (inv.series === 'warranty') { skip('warranty series', inv); continue; }
    if (inv.lines.length === 0) { skip('no frozen lines', inv); continue; }

    const totals = invoiceTotals(inv.lines);
    const computed = inv.vat_registered_at_issue ? totals.grossPennies : totals.netPennies;
    if (computed <= 0) { skip('zero total', inv); continue; }

    // ── A RECORDED FIGURE BEATS AN INFERRED ONE ──────────────────────────────────────────────
    // A few invoices already carry amount_paid_pennies with no ledger row: they were marked paid
    // in the window between the column landing and lib/payments becoming its only writer. That
    // figure is DIRECT evidence of what was received; the full total is an inference from "paid
    // meant paid in full". Where both exist the recorded one wins, and any disagreement is
    // REPORTED rather than resolved silently — reconcileInvoice recomputes the cache from the row
    // we write, so an inferred amount would otherwise overwrite a true one without trace.
    const recorded = inv.amount_paid_pennies;
    const amount = recorded ?? computed;
    if (recorded != null && recorded !== computed) {
      divergent.push({ n: inv.invoice_number, recorded, computed });
    }

    const collectedAt = effectivePaidDate(inv);
    if (!collectedAt) { skip('NO PAID DATE — cannot date a payment without inventing one', inv); continue; }

    todo.push({ inv, amount, collectedAt });
  }

  // ── WHAT WOULD BE WRITTEN ──────────────────────────────────────────────────────────────────
  console.log(`invoices examined : ${invoices.length}`);
  console.log(`to reconstruct    : ${todo.length}`);
  console.log(`value             : ${gbp(todo.reduce((a, t) => a + t.amount, 0))}`);
  if (todo.length) {
    const dates = todo.map((t) => t.collectedAt.getTime());
    console.log(`payment dates     : ${new Date(Math.min(...dates)).toISOString().slice(0, 10)} → ${new Date(Math.max(...dates)).toISOString().slice(0, 10)}`);
  }
  console.log('\nskipped:');
  for (const [why, list] of [...skips].sort((a, b) => b[1].length - a[1].length)) {
    console.log(`  ${pad(list.length, 5)} ${pad(why, 52)} ${list.slice(0, 5).join(', ')}${list.length > 5 ? ` …+${list.length - 5}` : ''}`);
  }

  // A cached figure with no ledger row is what the invariant gate is holding its nose about. After
  // this runs it should be zero for this tenant — printed so the claim is checkable, not asserted.
  const cachedNoLedger = invoices.filter((i) => i.amount_paid_pennies != null && i._count.payments === 0);
  console.log(`\ncached amount but no ledger row (the gate's ALLOW_PRE_BACKFILL case): ${cachedNoLedger.length}`);
  if (divergent.length) {
    console.log(`\n⚠ ${divergent.length} invoice(s) where the RECORDED amount differs from the invoice total.`);
    console.log('  The recorded figure is used. Check these before trusting the totals:');
    for (const d of divergent) console.log(`    ${pad(d.n, 12)} recorded ${pad(gbp(d.recorded), 12)} total ${gbp(d.computed)}`);
  }

  if (todo.length) {
    console.log('\nfirst 10:');
    for (const t of todo.slice(0, 10)) {
      console.log(`  ${pad(t.inv.invoice_number ?? '—', 12)} ${pad(gbp(t.amount), 12)} ${t.collectedAt.toISOString().slice(0, 10)}  ${t.inv.payment_method_snapshot ?? 'method not recorded'}`);
    }
  }

  if (!APPLY) {
    console.log('\nDRY RUN — nothing written. Re-run with --apply to write.');
  } else {
    let written = 0, noop = 0;
    for (const t of todo) {
      const row = await prisma.$transaction(async (tx) => recordPayment(tx, {
        groupId: g.id,
        invoiceId: t.inv.id,
        siteId: t.inv.site_id,
        amountPennies: t.amount,
        currency: t.inv.site?.currency_code ?? 'GBP',
        status: 'succeeded',
        paymentMethodId: t.inv.payment_method_id,
        paymentMethodSnapshot: t.inv.payment_method_snapshot,
        collectedAt: t.collectedAt,
        createdBy: null, // the backfill is not a person
        // THE KEY that makes the row self-describing. recordPayment derives `reconstructed` from it.
        sourceRef: `backfill:${t.inv.id}`,
        provider: 'manual',
      }));
      if (row) written++; else noop++;
    }
    console.log(`\nwritten: ${written}   already present (idempotent no-op): ${noop}`);

    // Prove it landed, by re-reading rather than by trusting the loop.
    const after = await prisma.payment.count({ where: { group_id: g.id, reconstructed: true } });
    const stillCached = await prisma.invoice.count({
      where: { group_id: g.id, amount_paid_pennies: { not: null }, payments: { none: {} } },
    });
    console.log(`reconstructed rows now on this tenant: ${after}`);
    console.log(`invoices still carrying a figure with no ledger row: ${stillCached}`);
  }
  console.log('');
} catch (e) {
  console.error(`\nFAILED: ${String(e?.message ?? e)}`);
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
