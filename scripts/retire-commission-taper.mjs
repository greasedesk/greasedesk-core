/**
 * File: scripts/retire-commission-taper.mjs
 * THE FORWARD AMENDMENT THAT ENDS THE TAPER — the record of what ran, kept because it ran against
 * production money config.
 *
 * ── WHAT WAS THERE ──────────────────────────────────────────────────────────────────────────────
 *   first_12m   £35.00  from 2026-07-01   (superseded)
 *   first_12m   £30.00  from 2026-08-20   (in force)
 *   thereafter  £12.50  from 2026-08-20   (in force — the taper)
 *
 * Commission is now FLAT: £30 a month for as long as the garage is a customer. The engine resolves
 * every rate on `thereafter` (lib/commission::ONGOING_TIER), and that key is currently £12.50 — so
 * until this row exists, a payment would accrue the taper amount.
 *
 * ── FORWARD, NOT A CORRECTION ───────────────────────────────────────────────────────────────────
 * The three rows above are in the past and frozen: the Rates surface allows edits only to rows that
 * are future AND unreferenced, and history is frozen by design. They stay exactly as they are —
 * £12.50 genuinely WAS the ongoing rate for a period, even though nobody was ever paid it. This
 * appends one row; it corrects nothing.
 *
 * TODAY'S DATE, not tomorrow's. The append-only-forward rule requires a boundary strictly after the
 * latest for the key (2026-08-20); it does NOT require the future — only a CORRECTION does. Dating
 * this today closes the window in which a payment would resolve £12.50 rather than leaving one open.
 *
 * ── AND THE REDUCED RATE ────────────────────────────────────────────────────────────────────────
 * amount_unvisited_pennies is set on the new row and left NULL on the three historical ones, where
 * it is true rather than unfilled: the visit gate did not exist when they were written.
 *
 * ── IT WRITES THE SAME AUDIT THE RATES API WRITES ───────────────────────────────────────────────
 * `rate.created`, so a row added by script is indistinguishable in the ledger from one added by an
 * operator through the Engine Room. A money-config change with no audit row is the thing this
 * codebase keeps refusing to allow.
 *
 * ── REFUSALS ────────────────────────────────────────────────────────────────────────────────────
 * Refuses if a rate already exists on the target date (one boundary per date — the DB has a unique
 * index and this says so first), and refuses if the latest existing boundary is not the £12.50 row
 * it expects, because then the timeline is not what this script was written against.
 *
 *   node scripts/retire-commission-taper.mjs            (dry run)
 *   node scripts/retire-commission-taper.mjs --commit
 */
import './_gate-preflight.mjs';
const { gatePrisma } = await import('./_gate-preflight.mjs');
import './_ts.mjs';
const { ONGOING_TIER, SUBSCRIPTION } = await import('../lib/commission.ts');
const prisma = await gatePrisma();

const OPERATOR_ID = 'acab39ee-aea8-4ae8-b855-312007bebdb2'; // hugh@greasedesk.com, owner
const COUNTRY = 'GB', CURRENCY = 'GBP';
const FLAT_PENNIES = 3000;        // £30.00 — the same in month one and month sixty
const UNVISITED_PENNIES = 1250;   // £12.50 — paid when that month's visit did not happen
const EFFECTIVE_FROM = new Date('2026-09-06T00:00:00.000Z');
const EXPECT_SUPERSEDES = 1250;   // the taper row this is written to end

const dry = !process.argv.includes('--commit');
const M = (p) => (p == null ? 'null' : `£${(p / 100).toFixed(2)}`);
console.log(dry ? '— DRY RUN. Pass --commit to write. —\n' : '— COMMITTING —\n');

const key = { revenue_stream: SUBSCRIPTION, country_code: COUNTRY, currency: CURRENCY, tier: ONGOING_TIER };
const timeline = await prisma.commissionRate.findMany({
  where: { revenue_stream: SUBSCRIPTION, country_code: COUNTRY, currency: CURRENCY },
  orderBy: { effective_from: 'asc' },
});
console.log(`${COUNTRY}/${CURRENCY} timeline:`);
for (const r of timeline) console.log(`   ${r.tier.padEnd(10)} ${M(r.amount_pennies).padStart(7)}  unvisited=${M(r.amount_unvisited_pennies).padStart(7)}  from ${r.effective_from.toISOString().slice(0, 10)}`);

const latest = await prisma.commissionRate.findFirst({ where: key, orderBy: { effective_from: 'desc' } });
console.log(`\nlatest on "${ONGOING_TIER}": ${latest ? `${M(latest.amount_pennies)} from ${latest.effective_from.toISOString().slice(0, 10)}` : 'none'}`);

if (!latest) {
  console.log(`REFUSING: no existing "${ONGOING_TIER}" rate — this script amends a timeline it expects to find.`);
  await prisma.$disconnect(); process.exit(1);
}
if (latest.amount_pennies !== EXPECT_SUPERSEDES) {
  console.log(`REFUSING: expected to supersede ${M(EXPECT_SUPERSEDES)}, found ${M(latest.amount_pennies)}. The timeline is not what this was written against.`);
  await prisma.$disconnect(); process.exit(1);
}
if (+latest.effective_from >= +EFFECTIVE_FROM) {
  console.log(`REFUSING: append-only-forward — the latest boundary is ${latest.effective_from.toISOString().slice(0, 10)}, not before ${EFFECTIVE_FROM.toISOString().slice(0, 10)}.`);
  await prisma.$disconnect(); process.exit(1);
}
if (await prisma.commissionRate.findFirst({ where: { ...key, effective_from: EFFECTIVE_FROM } })) {
  console.log('REFUSING: a rate already starts on that date — one boundary per date.');
  await prisma.$disconnect(); process.exit(1);
}

console.log(`\nwould write: ${ONGOING_TIER} ${M(FLAT_PENNIES)} (unvisited ${M(UNVISITED_PENNIES)}) from ${EFFECTIVE_FROM.toISOString().slice(0, 10)}`);
if (dry) { console.log('\n   dry run — nothing written'); await prisma.$disconnect(); process.exit(0); }

const created = await prisma.commissionRate.create({
  data: { ...key, amount_pennies: FLAT_PENNIES, amount_unvisited_pennies: UNVISITED_PENNIES,
    effective_from: EFFECTIVE_FROM, created_by: OPERATOR_ID },
});
// THE SAME AUDIT THE RATES API WRITES, so the ledger cannot tell a script from an operator.
await prisma.superAdminAudit.create({
  data: {
    operator_user_id: OPERATOR_ID, action: 'rate.created',
    target_group_id: null, target_operator_id: null,
    target_name_snapshot: `${COUNTRY}/${CURRENCY}/${ONGOING_TIER}`,
    target_ref_snapshot: EFFECTIVE_FROM.toISOString().slice(0, 10),
    reason: 'Taper retired: commission is a flat £30 per garage per month for as long as the garage is a customer. '
      + 'Supersedes the £12.50 ongoing rate. Reduced rate set for months where the visit did not happen.',
    detail: {
      country_code: COUNTRY, currency: CURRENCY, tier: ONGOING_TIER,
      amount_pennies: FLAT_PENNIES, amount_unvisited_pennies: UNVISITED_PENNIES,
      effective_from: EFFECTIVE_FROM.toISOString().slice(0, 10),
      supersedes: { amount_pennies: latest.amount_pennies, effective_from: latest.effective_from.toISOString().slice(0, 10) },
      amended: true, via: 'scripts/retire-commission-taper',
    },
  },
});
console.log(`\n   written: ${created.id}`);
const after = await prisma.commissionRate.findMany({
  where: { revenue_stream: SUBSCRIPTION, country_code: COUNTRY, currency: CURRENCY }, orderBy: { effective_from: 'asc' },
});
console.log('\n   after:');
for (const r of after) console.log(`     ${r.tier.padEnd(10)} ${M(r.amount_pennies).padStart(7)}  unvisited=${M(r.amount_unvisited_pennies).padStart(7)}  from ${r.effective_from.toISOString().slice(0, 10)}`);
await prisma.$disconnect();
