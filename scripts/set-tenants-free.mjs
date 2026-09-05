/**
 * File: scripts/set-tenants-free.mjs
 * SET TWO TENANTS FREE — the record of what ran, kept because it ran against production data.
 *
 * ── WHO, AND WHY EACH ───────────────────────────────────────────────────────────────────────────
 *   GB-GD1967  The Mini & BMW Specialist — the owner's own garage. Free permanently.
 *   US-GD2175  ZZUS Motors — the standing non-GB test tenant, pinned by ref in two gates
 *              (application-fee-gate needs a second tenant that is ours; tax-display-gate needs the
 *              only sales_tax tenant in the database). It will never buy a subscription.
 *
 * ── TMBS IS SET FREE AND DELIBERATELY NOT `is_internal` ─────────────────────────────────────────
 * They are different claims. `free` says "pays nothing"; `is_internal` says "ours", and it removes a
 * tenant from the count, the forecast and every revenue and commission figure. TMBS carries 303 job
 * cards, 254 real customers and the June golden figures every dashboard assertion is measured
 * against. Taking it out of those numbers is a decision on its own and nobody has made it, so this
 * script does not make it by accident.
 *
 * ZZUS is already the standing test tenant and is_internal is left exactly as it is here too —
 * this script writes free_since and free_reason and nothing else, so what it did is legible from
 * what it touched.
 *
 * ── REFUSALS ────────────────────────────────────────────────────────────────────────────────────
 * Resolved by ref, never by name (groups legitimately share names). Refuses a tenant that is
 * already free rather than overwriting the date somebody else set, because "free since" is the
 * decision and re-dating it would erase when it was taken.
 */
import './_gate-preflight.mjs';
const { gatePrisma, describeError } = await import('./_gate-preflight.mjs');
import './_ts.mjs';
const prisma = await gatePrisma();

const SUBJECTS = [
  { ref: 'GB-GD1967', reason: 'Owner-operated garage — the product is built here; never billed.' },
  { ref: 'US-GD2175', reason: 'Standing non-GB test tenant, pinned by ref in application-fee-gate and tax-display-gate; never a paying customer.' },
];

const dry = !process.argv.includes('--commit');
console.log(dry ? '— DRY RUN. Pass --commit to write. —\n' : '— COMMITTING —\n');

for (const s of SUBJECTS) {
  const g = await prisma.group.findFirst({
    where: { ref: s.ref },
    select: { id: true, ref: true, group_name: true, is_internal: true, is_demo: true, free_since: true, free_reason: true },
  });
  if (!g) { console.log(`${s.ref}  NOT FOUND — nothing done`); continue; }
  console.log(`${g.ref}  ${g.group_name}`);
  console.log(`   before: free_since=${g.free_since?.toISOString() ?? 'null'}  is_internal=${g.is_internal}  is_demo=${g.is_demo}`);
  if (g.free_since) {
    console.log('   REFUSED: already free. Re-dating would erase when the decision was taken.\n');
    continue;
  }
  if (dry) { console.log(`   would set free_since=now, free_reason="${s.reason}"\n`); continue; }
  const after = await prisma.group.update({
    where: { id: g.id },
    data: { free_since: new Date(), free_reason: s.reason },
    select: { free_since: true, free_reason: true, is_internal: true },
  });
  console.log(`   after:  free_since=${after.free_since?.toISOString()}  is_internal=${after.is_internal} (untouched)`);
  console.log(`   reason: ${after.free_reason}\n`);
}

await prisma.$disconnect();
