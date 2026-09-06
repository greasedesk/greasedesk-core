/**
 * File: scripts/migrate-overheads-to-costs.mjs
 * ONE-OFF: carry a tenant's Overhead rows into the Cost model.
 *
 * ── WHY A SCRIPT AND NOT A MIGRATION ────────────────────────────────────────────────────────────
 * Generating instances is lib/costs's job — cadence phase, the rate effective at each period start,
 * and the never-overwrite-an-edit rule all live there and are gated. Re-implementing that in SQL
 * would be a second copy of the rule that nothing tests, which is the divergence this codebase
 * keeps paying for. So the migration reuses the tested function and runs deliberately.
 *
 * ADDITIVE ONLY. It writes Cost/CostRate/CostInstance and reads Overhead; it deletes nothing and
 * edits nothing. Retiring the Overhead rows is a separate decision.
 *
 * REFUSES rather than guesses:
 *   • a tenant that already has costs — running twice must not double a garage's cost base
 *   • a WEEKLY overhead — the new model has monthly/quarterly/annual, and ×52÷12 would bake an
 *     approximation into a stored amount where the old model at least computed it on the fly
 *
 * ── WHAT THE CARRY ASSUMES, AND WHERE THAT IS WRITTEN DOWN ──────────────────────────────────────
 * The old register had NO DATES. So active_from is the reporting anchor, and the rate in force at
 * that date is today's figure — inferred, not known. There is no evidence about what the rent was
 * in April; this is the honest default and it is still an assumption, baked in permanently.
 *
 * Nothing about a Cost row says that. Six months from now it reads as a figure somebody typed. So
 * each carried cost writes an AuditLog row on the tenant's own ledger naming the overhead it came
 * from, the anchor, and the fact that the rate is inferred.
 *
 * ── IT APPLIES ONLY WHEN TOLD TO ────────────────────────────────────────────────────────────────
 * This used to WRITE by default and take --dry-run as the opt-out, which is the wrong way round for
 * a script that alters a tenant's reported figures — and out of step with set-tenants-free and
 * clear-stranded-subscriptions, which both require an explicit flag. A bare run is now a dry run.
 *
 *   node scripts/migrate-overheads-to-costs.mjs GB-GD1967              (dry run)
 *   node scripts/migrate-overheads-to-costs.mjs --apply GB-GD1967
 */
import './_gate-preflight.mjs';
const { gatePrisma } = await import('./_gate-preflight.mjs');
import './_ts.mjs';
const { regenerate } = await import('../lib/costs.ts');
const { writeAudit } = await import('../lib/audit.ts');

const args = process.argv.slice(2);
// DRY BY DEFAULT. --dry-run is still accepted so the documented invocation keeps working.
const dry = !args.includes('--apply');
const refs = args.filter((a) => !a.startsWith('--'));
if (!refs.length) { console.error('Name the tenants by ref.'); process.exit(2); }

const prisma = await gatePrisma();
const m = (p) => `£${(p / 100).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const CADENCE = { monthly: 'monthly', annual: 'annual' };   // `weekly` deliberately absent

// Far enough forward that the three forward tiles have something to read.
const now = new Date();
const horizon = new Date(Date.UTC(now.getUTCFullYear() + 1, now.getUTCMonth() + 3, 1));

let failed = false;
for (const ref of refs) {
  // BY REF, never by name — two of these tenants share a generated name shape.
  const g = await prisma.group.findFirst({ where: { ref }, select: { id: true, group_name: true, reporting_start_date: true } });
  if (!g) { console.log(`${ref}: NOT FOUND — skipped`); failed = true; continue; }

  const existing = await prisma.cost.count({ where: { group_id: g.id } });
  if (existing > 0) { console.log(`${ref} ${g.group_name}: REFUSING — ${existing} cost(s) already exist`); failed = true; continue; }

  const overheads = await prisma.overhead.findMany({
    where: { group_id: g.id, is_active: true },
    orderBy: { created_at: 'asc' },
    select: { id: true, name: true, ex_vat_amount_pennies: true, period: true, allocations: { select: { site_id: true, percent: true } } },
  });
  const weekly = overheads.filter((o) => !CADENCE[o.period]);
  if (weekly.length) {
    console.log(`${ref} ${g.group_name}: REFUSING — ${weekly.length} weekly overhead(s): ${weekly.map((o) => o.name).join(', ')}`);
    console.log('   The new model has no weekly cadence. Decide the cadence for these by hand rather than');
    console.log('   letting a script store x52/12 as if it were the entered figure.');
    failed = true; continue;
  }

  // active_from = THE REPORTING ANCHOR, so instances exist across the whole span the dashboard can
  // report on. Starting later would leave the earliest reported months with no cost at all.
  const from = g.reporting_start_date;
  console.log(`\n${ref} ${g.group_name}  anchor ${from.toISOString().slice(0, 10)} → horizon ${horizon.toISOString().slice(0, 10)}`);

  for (const o of overheads) {
    const alloc = o.allocations.filter((a) => Number(a.percent) > 0);
    if (!alloc.length) { console.log(`   ${o.name}: no allocation — skipped`); continue; }
    if (dry) { console.log(`   would create ${o.name.padEnd(24)} ${m(o.ex_vat_amount_pennies)} ${o.period} spread`); continue; }
    const cost = await prisma.cost.create({
      data: {
        group_id: g.id, name: o.name, cadence: CADENCE[o.period], charge: 'spread', active_from: from,
        rates: { create: [{ effective_from: from, amount_pennies: o.ex_vat_amount_pennies }] },
        // SPREAD, matching the old register's annual/12 exactly, so no figure moves in the carry.
        allocations: { create: alloc.map((a) => ({ group_id: g.id, site_id: a.site_id, percent: a.percent })) },
      },
      select: { id: true },
    });
    const r = await regenerate(cost.id, from, horizon);
    // THE ASSUMPTION, ON THE TENANT'S OWN LEDGER. user_id null: nobody inside the garage did this.
    await prisma.$transaction(async (tx) => {
      await writeAudit(tx, {
        groupId: g.id, userId: null, entity: 'cost', entityId: cost.id,
        action: 'cost.migrated_from_overhead',
        diff: {
          name: o.name,
          fromOverheadId: o.id,
          amountPennies: o.ex_vat_amount_pennies,
          period: o.period,
          cadence: CADENCE[o.period],
          charge: 'spread',
          activeFrom: from.toISOString(),
          instancesWritten: r.written,
          // The two things a reader six months from now cannot recover from the row itself.
          activeFromIs: 'the tenant reporting anchor — the old register held no dates',
          rateIsInferred: 'the amount in force at that date is TODAY\'s figure; what it was in April is not known',
        },
      });
    });
    console.log(`   ${o.name.padEnd(24)} ${m(o.ex_vat_amount_pennies).padStart(11)} ${o.period.padEnd(8)} → ${r.written} instances, audited`);
  }
}
await prisma.$disconnect();
process.exit(failed ? 1 : 0);
