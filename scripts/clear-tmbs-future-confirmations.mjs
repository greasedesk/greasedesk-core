/**
 * File: scripts/clear-tmbs-future-confirmations.mjs
 * WITHDRAW SIX CONFIRMATIONS AND ONE RATE THAT RECORDS A CHANGE THAT DID NOT HAPPEN —
 * the record of what ran, kept because it ran against production data and because what it clears
 * exists nowhere else afterwards.
 *
 * ── WHAT HAPPENED ───────────────────────────────────────────────────────────────────────────────
 * 2026-09-06 13:58  TMBS's overheads were carried into Costs (42 instances, all estimates).
 * 2026-09-06 14:13  Twelve Building Rent months were confirmed one at a time from /admin/costs,
 *                   each at the figure already shown. SIX of them are in the FUTURE —
 *                   2026-10 through 2027-03.
 * 2026-09-06 14:13:59  A second CostRate was written at effective_from 2026-09-01, £1,656.77 —
 *                   the same amount as the 2026-04-01 rate it sits after.
 *
 * Neither was possible to see afterwards. The per-row Save left `edited_by` on the row and no audit
 * row at all: the audit for that path shipped later the same day, so nothing recorded either act.
 *
 * ── WHY THE SIX ARE WRONG, GIVEN NOTHING MOVED ──────────────────────────────────────────────────
 * `is_estimate` changes no figure. `edited_at` does: it is the ONE thing regeneration refuses to
 * overwrite. So those six months are immune to a future rate change while being labelled estimates
 * — a rent rise dated January 2027 would silently not reach them, and no screen would say so.
 * Confirming a bill that has not arrived is a prediction wearing the wrong label; the control that
 * shipped today refuses it, and this withdraws the ones made before it existed.
 *
 * ── AND WHY THE RATE IS NOT A SPARE ROW ─────────────────────────────────────────────────────────
 * A dated rate means "the price changed from this month". One written for a change that did not
 * happen is a false fact about the business. It is currently harmless only because the amount
 * matches — which is exactly the shape that survives review.
 *
 * ── REFUSALS, RATHER THAN GUESSES ───────────────────────────────────────────────────────────────
 * Resolved by ref, never by name. Refuses if the subject cost is not unique. Refuses the WHOLE act
 * if any in-scope instance holds an amount the rate would not generate: that would be a figure
 * somebody TYPED, and clearing it would destroy information rather than withdraw a claim. Refuses
 * if the 2026-09-01 rate differs in amount from the one before it — that would be a real change.
 *
 * ── THE AUDIT ROWS ARE WRITTEN FIRST, AND READ BACK, BEFORE ANYTHING IS CLEARED ─────────────────
 * Afterwards they are the only record that these six were ever confirmed and that the rate ever
 * existed. A failed audit write aborts the clear rather than proceeding without the record — the
 * same ordering as clear-stranded-subscriptions and clear-tmbs-free-flag, for the same reason.
 *
 *   node scripts/clear-tmbs-future-confirmations.mjs            (dry run)
 *   node scripts/clear-tmbs-future-confirmations.mjs --commit
 */
import './_gate-preflight.mjs';
const { gatePrisma } = await import('./_gate-preflight.mjs');
import './_ts.mjs';
const { rateFor } = await import('../lib/costs.ts');
const { writeAudit } = await import('../lib/audit.ts');
const prisma = await gatePrisma();

const REF = 'GB-GD1967';
const COST_NAME = 'Building Rent';
const SPURIOUS_RATE_FROM = '2026-09-01';
const dry = !process.argv.includes('--commit');
const M = (p) => `£${(p / 100).toFixed(2)}`;
console.log(dry ? '— DRY RUN. Pass --commit to write. —\n' : '— COMMITTING —\n');

const g = await prisma.group.findFirst({ where: { ref: REF }, select: { id: true, ref: true, group_name: true } });
if (!g) { console.log(`${REF}: NOT FOUND`); await prisma.$disconnect(); process.exit(1); }

const costs = await prisma.cost.findMany({
  where: { group_id: g.id, name: COST_NAME },
  select: { id: true, name: true, rates: { select: { id: true, effective_from: true, amount_pennies: true, created_at: true }, orderBy: { effective_from: 'asc' } } },
});
if (costs.length !== 1) {
  console.log(`REFUSING: expected exactly one "${COST_NAME}" on ${REF}, found ${costs.length}`);
  await prisma.$disconnect(); process.exit(1);
}
const cost = costs[0];
const now = new Date();

// ── THE SIX ──────────────────────────────────────────────────────────────────────────────────
const inScope = await prisma.costInstance.findMany({
  where: { cost_id: cost.id, is_estimate: false, due_on: { gt: now } },
  select: { id: true, period_start: true, due_on: true, amount_pennies: true, edited_at: true, edited_by: true },
  orderBy: { period_start: 'asc' },
});
console.log(`${g.ref}  ${g.group_name}  —  ${cost.name}`);
console.log(`   ${inScope.length} confirmed month(s) with a due date in the future:`);
for (const i of inScope) console.log(`     ${i.period_start.toISOString().slice(0, 10)}  ${M(i.amount_pennies)}  confirmed ${i.edited_at?.toISOString().slice(0, 19)}`);

// A TYPED FIGURE IS NOT A CLAIM TO WITHDRAW. Compare each against what the rate generates.
const mismatched = inScope.filter((i) => rateFor(cost.rates, i.period_start) !== i.amount_pennies);
if (mismatched.length) {
  console.log('\n   REFUSING: these hold an amount the rate would not generate, so somebody typed them:');
  for (const i of mismatched) console.log(`     ${i.period_start.toISOString().slice(0, 10)}  row ${M(i.amount_pennies)} vs rate ${M(rateFor(cost.rates, i.period_start) ?? 0)}`);
  await prisma.$disconnect(); process.exit(1);
}

// ── THE RATE ─────────────────────────────────────────────────────────────────────────────────
const spurious = cost.rates.find((r) => r.effective_from.toISOString().slice(0, 10) === SPURIOUS_RATE_FROM);
const previous = [...cost.rates].reverse().find((r) => r.effective_from < (spurious?.effective_from ?? now));
console.log(`\n   rates: ${cost.rates.map((r) => `${r.effective_from.toISOString().slice(0, 10)} ${M(r.amount_pennies)}`).join('  |  ')}`);
if (!spurious) {
  console.log(`   no ${SPURIOUS_RATE_FROM} rate — nothing to clear there`);
} else if (!previous) {
  console.log(`   REFUSING: no earlier rate to compare ${SPURIOUS_RATE_FROM} against`);
  await prisma.$disconnect(); process.exit(1);
} else if (previous.amount_pennies !== spurious.amount_pennies) {
  console.log(`   REFUSING: ${SPURIOUS_RATE_FROM} is ${M(spurious.amount_pennies)} against ${M(previous.amount_pennies)} before it — that is a real change, not a duplicate`);
  await prisma.$disconnect(); process.exit(1);
}

if (!inScope.length && !spurious) { console.log('\n   nothing to do'); await prisma.$disconnect(); process.exit(0); }
if (dry) {
  console.log(`\n   would write ${inScope.length ? 'an audit row for the six confirmations' : ''}${inScope.length && spurious ? ' and ' : ''}${spurious ? 'one for the rate' : ''}, read them back, then clear`);
  await prisma.$disconnect(); process.exit(0);
}

// ── THE RECORD FIRST. Not caught: if this fails, nothing is cleared. ──────────────────────────
let instAuditId = null, rateAuditId = null;
if (inScope.length) {
  await prisma.$transaction(async (tx) => {
    await writeAudit(tx, {
      groupId: g.id, userId: null, entity: 'cost', entityId: cost.id,
      action: 'cost.instances_unconfirmed',
      diff: {
        costName: cost.name,
        reason: 'Confirmed in error before the fallen-due rule existed: these months had not arrived. '
          + 'is_estimate, edited_at and edited_by cleared together — edited_at is the regeneration lock, and '
          + 'leaving it set would keep the months immune to a future rate change while calling them estimates.',
        cleared: inScope.map((i) => ({
          period: i.period_start.toISOString().slice(0, 10),
          dueOn: i.due_on.toISOString().slice(0, 10),
          amountPennies: i.amount_pennies,
          confirmedAt: i.edited_at?.toISOString() ?? null,
          confirmedBy: i.edited_by,
        })),
      },
    });
  });
  instAuditId = (await prisma.auditLog.findFirst({ where: { group_id: g.id, action: 'cost.instances_unconfirmed' }, orderBy: { created_at: 'desc' }, select: { id: true } }))?.id ?? null;
}
if (spurious) {
  await prisma.$transaction(async (tx) => {
    await writeAudit(tx, {
      groupId: g.id, userId: null, entity: 'cost', entityId: cost.id,
      action: 'cost.rate_removed',
      diff: {
        costName: cost.name,
        reason: 'Recorded a rent change that did not happen — same amount as the rate before it, written in the '
          + 'same session as the six confirmations. A dated rate means "the price changed from this month".',
        removed: {
          effectiveFrom: spurious.effective_from.toISOString().slice(0, 10),
          amountPennies: spurious.amount_pennies,
          rowCreatedAt: spurious.created_at.toISOString(),
        },
        remaining: { effectiveFrom: previous.effective_from.toISOString().slice(0, 10), amountPennies: previous.amount_pennies },
      },
    });
  });
  rateAuditId = (await prisma.auditLog.findFirst({ where: { group_id: g.id, action: 'cost.rate_removed' }, orderBy: { created_at: 'desc' }, select: { id: true } }))?.id ?? null;
}

// READ THEM BACK. After this they are the only copies of what is about to be removed.
if (inScope.length) {
  const back = await prisma.auditLog.findUnique({ where: { id: instAuditId }, select: { diff_json: true } });
  const kept = (back?.diff_json ?? {}).cleared ?? [];
  if (kept.length !== inScope.length) throw new Error(`REFUSING: the audit row carries ${kept.length} months, not ${inScope.length}`);
  console.log(`\n   audit ${instAuditId} written and read back, carrying ${kept.length} months`);
}
if (spurious) {
  const back = await prisma.auditLog.findUnique({ where: { id: rateAuditId }, select: { diff_json: true } });
  const kept = (back?.diff_json ?? {}).removed ?? {};
  if (kept.effectiveFrom !== SPURIOUS_RATE_FROM) throw new Error(`REFUSING: the audit row does not carry the rate back (${JSON.stringify(kept)})`);
  console.log(`   audit ${rateAuditId} written and read back, carrying the ${kept.effectiveFrom} rate`);
}

// ── AND ONLY NOW, THE CLEAR ──────────────────────────────────────────────────────────────────
if (inScope.length) {
  const r = await prisma.costInstance.updateMany({
    where: { id: { in: inScope.map((i) => i.id) } },
    // All three together: they are one fact, and edited_at is the half that actually does something.
    data: { is_estimate: true, edited_at: null, edited_by: null },
  });
  console.log(`   ${r.count} month(s) back to estimates, unlocked`);
}
if (spurious) {
  await prisma.costRate.delete({ where: { id: spurious.id } });
  console.log(`   rate ${SPURIOUS_RATE_FROM} removed`);
}

const after = await prisma.cost.findUnique({ where: { id: cost.id },
  select: { rates: { select: { effective_from: true, amount_pennies: true }, orderBy: { effective_from: 'asc' } },
    instances: { where: { due_on: { gt: now } }, select: { is_estimate: true, edited_at: true } } } });
console.log(`\n   after:  rates = ${after.rates.map((r) => `${r.effective_from.toISOString().slice(0, 10)} ${M(r.amount_pennies)}`).join(', ')}`);
console.log(`           future months: ${after.instances.length}, all estimates = ${after.instances.every((i) => i.is_estimate)}, all unlocked = ${after.instances.every((i) => i.edited_at === null)}`);
await prisma.$disconnect();
