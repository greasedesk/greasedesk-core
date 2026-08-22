/**
 * File: scripts/demo-generation-gate.mjs
 * GENERATE A THROWAWAY DEMO TENANT AND ASSERT THE DASHBOARD'S FIGURES AGREE WITH EACH OTHER —
 * so the next rule the app starts depending on fails loudly at generation, not in front of a
 * prospect.
 *
 *   node scripts/demo-generation-gate.mjs > /tmp/gen-gate.log 2>&1; echo $?
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────────────────────────────
 * Three times in two days the sales demo was broken by the same structural gap: demo data built by
 * a path that did not know a rule the app had since started depending on.
 *
 *   1. phone_e164   — reachability started reading the derived column; the generator wrote only
 *                     the raw one. Every customer became untextable.
 *   2. demo subject — every seeded number was unroutable by design, so the SMS journey completed
 *                     into a void.
 *   3. Payment rows — revenue started deriving from the ledger; the generator only stamped the
 *                     invoice paid. The first screen a prospect sees read £0.00 across 714 paid
 *                     invoices.
 *
 * Each is one shape: A DERIVED PAIR WHERE ONE SIDE WAS POPULATED AND THE OTHER WASN'T. So the gate
 * asserts RELATIONSHIPS between figures, never magnitudes.
 *
 * ── NO MAGNITUDE BANDS, DELIBERATELY ────────────────────────────────────────────────────────────
 * Pinned numbers have failed three times in two days on values that were entitled to move:
 * demo-profile-gate pinned TMBS's live trading figures, demo-subject-gate (twice) pinned a phone
 * number the demo exists to overwrite. "Revenue > £200k" breaks the day the profile is
 * recalibrated. Paid ≤ issued does not. The standing rule: pin the rule, not the number, when the
 * number can legitimately move.
 *
 * ── WHAT IT DOES NOT COVER ──────────────────────────────────────────────────────────────────────
 *   - The HARDCODED-TOWN class of defect: two subjects sharing one generated label. No figure is
 *     wrong there — the tenant is internally consistent and lies only in relation to another
 *     tenant. A relationship gate over one tenant's numbers cannot see it.
 *   - Rendering: the clipped "£" was a CSS flex fight on the served page; these figures are
 *     computed server-side and would have read correctly throughout.
 *   - Send behaviour: whether a text actually goes is lib/notify + policy, gated elsewhere
 *     (send-outcome-gate, notify-scope-gate).
 *   - Magnitude sanity. A demo generating one job a year passes this gate if its pairs agree.
 *     That is the price of never pinning a number; the calibration profile owns plausibility.
 *
 * ── COST — MEASURED, NOT ESTIMATED ──────────────────────────────────────────────────────────────
 * First run 2026-08-18: 1443s TOTAL (~24 minutes) — 1435s generation, 3s purge, the rest
 * assertions. The pre-run estimate said "5–6 minutes" from ~650 jobs at ~500ms; the generator
 * actually writes ~870 cards plus the quote pile, and the mints serialise on the gapless sequence.
 * PRE-RELEASE ONLY, not per-push. Runtime is printed at the end of every run so this number stays
 * a measurement rather than a memory.
 *
 * ── SAFETY ──────────────────────────────────────────────────────────────────────────────────────
 * The tenant is created is_demo (all sends blocked) with demo_expires_at ALREADY IN THE PAST, so if
 * teardown dies the lifecycle cron reaps the leftover instead of it living forever. The destructive
 * step (purge) is scoped by the script to the tenant id THIS RUN created, re-checked against the
 * database, and refused if it is listed in DEMO_TENANTS or is the frozen reference — the standing
 * rule that a destructive e2e asserts its own fixtures are the only candidates in scope.
 */
import './_gate-preflight.mjs';
import './_ts.mjs';
const t0 = Date.now();
const { prisma } = await import('../lib/db.ts');
const { generateDemoTenant } = await import('../lib/demo/generate.ts');
const { purgeTenant } = await import('../lib/tenant-purge.ts');
const { isListedDemoTenant } = await import('../lib/demo-tenants.ts');
const { TILE_COMPUTES, MONTH_TILE_COMPUTES } = await import('../lib/dashboard-tiles.ts');
const bcrypt = (await import('bcryptjs')).default;

const out = [];
const check = (n, ok, d = '') => { out.push(ok ? 'P' : 'F'); console.log(`${ok ? '✓' : '✗'} ${n}${d ? `  — ${d}` : ''}`); };
const gbp = (p) => `£${((p ?? 0) / 100).toFixed(2)}`;

// ── THE RULE, AS A PURE FUNCTION, PROVEN RED BEFORE ANY DATA EXISTS ─────────────────────────────
/** A document-side figure with a silent ledger side. Null = fine; string = the violation. */
const ledgerLag = (docSide, ledgerSide) =>
  docSide > 0 && !(ledgerSide > 0) ? `document side ${docSide}, ledger side ${ledgerSide ?? 0}` : null;

console.log('— the rule can fail (pure, no tenant involved) —');
check('flags a populated document side with a zero ledger side', ledgerLag(714, 0) !== null);
check('flags a null ledger side the same way', ledgerLag(714, null) !== null);
check('passes when both sides are populated', ledgerLag(714, 25723740) === null);
check('passes when both sides are empty — absence agreeing with absence', ledgerLag(0, 0) === null);

// ── GENERATE ────────────────────────────────────────────────────────────────────────────────────
console.log('\n— generating the throwaway tenant (the slow part) —');
const epoch = Date.now();
let groupId = null;
try {
  const gen0 = Date.now();
  const res = await generateDemoTenant({
    seed: `generation-gate-${epoch}`,
    now: new Date(),
    // "Gateholm" derives postcode area GA — not a real UK area, so localityFor accepts it.
    groupName: 'Gateholm Motor Company',
    // RFC 2606 .invalid: undeliverable by construction, and epoch-unique so billing_email's
    // uniqueness cannot collide with a previous run that failed before teardown.
    ownerEmail: `generation-gate-${epoch}@example.invalid`,
    ownerName: 'Generation Gate',
    ownerPasswordHash: bcrypt.hashSync(`gate-${epoch}`, 4),
    // ALREADY EXPIRED: if teardown dies, the lifecycle cron purges the leftover.
    expiresAt: new Date(Date.now() - 60_000),
    isDemo: true, // sends blocked at sendNotification — this tenant must never text anyone
    onProgress: (s, d) => console.log(`  ${s}${d ? ` — ${d}` : ''}`),
  });
  groupId = res.groupId;
  const genSecs = Math.round((Date.now() - gen0) / 1000);
  console.log(`\ngenerated ${groupId} in ${genSecs}s`);

  const sites = (await prisma.site.findMany({ where: { group_id: groupId }, select: { id: true } })).map((s) => s.id);
  const now = new Date();
  const full = { from: new Date(now.getTime() - 400 * 86400_000), to: new Date(now.getTime() + 86400_000) };
  const ctx = { groupId, siteIds: sites, now, months: 12, dataStart: null, ...full };

  // ── THE NAMED RELATIONSHIPS ───────────────────────────────────────────────────────────────────
  console.log('\n— paid ≤ issued, over the tenant\'s whole history —');
  const ivp = await TILE_COMPUTES.issuedVsPaid(ctx);
  // Whole history ONLY: within a single month paid legitimately exceeds issued (August's account
  // customers paying July's invoices read 42 paid against 37 issued). Over all time, a tenant that
  // has never taken a deposit cannot have received more than it billed.
  check('paid ≤ issued', ivp.paidPennies <= ivp.issuedPennies,
    `${ivp.paidCount} paid ${gbp(ivp.paidPennies)} vs ${ivp.issuedCount} issued ${gbp(ivp.issuedPennies)}`);
  check('paid invoices exist at all — the check above is not vacuous', ivp.paidCount > 0, `${ivp.paidCount}`);

  console.log('\n— every ledger-derived figure non-zero when its document counterpart is —');
  const rev = await TILE_COMPUTES.revenue(ctx);
  check('revenue (ledger) is non-zero because paid invoices (documents) exist',
    ledgerLag(rev.count, rev.grossPennies) === null, `${rev.count} invoices → ${gbp(rev.grossPennies)}`);
  check('issuedVsPaid paid-money agrees with its own paid-count',
    ledgerLag(ivp.paidCount, ivp.paidPennies) === null, gbp(ivp.paidPennies));
  const pnl = await MONTH_TILE_COMPUTES.pnl(ctx);
  check('document revenue (P&L) implies ledger revenue',
    ledgerLag(pnl.revenueNet, rev.grossPennies) === null,
    `P&L ${gbp(pnl.revenueNet)} → ledger ${gbp(rev.grossPennies)}`);

  // Month-by-month: the August defect in miniature. Any month with paid documents must show money.
  console.log('\n— and per month, so a partial gap cannot hide inside a good year —');
  let monthViolations = [];
  for (let m = 0; m < 12; m++) {
    const from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - m, 1));
    const to = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - m + 1, 1));
    const r = await TILE_COMPUTES.revenue({ ...ctx, from, to });
    const v = ledgerLag(r.count, r.grossPennies);
    if (v) monthViolations.push(`${from.toISOString().slice(0, 7)}: ${r.count} paid, ${gbp(r.grossPennies)}`);
  }
  check('no month has paid invoices and £0.00 revenue', monthViolations.length === 0,
    monthViolations.join('; ') || '12 months clean');

  // ── THE SAME RULE AT THE ROW GRAIN — the pairs that actually broke ────────────────────────────
  console.log('\n— the row-grain pairs behind the three incidents —');
  const paidChargeable = await prisma.invoice.count({ where: { group_id: groupId, status: 'paid', series: 'chargeable' } });
  const paidWithLedger = await prisma.invoice.count({ where: { group_id: groupId, status: 'paid', series: 'chargeable', payments: { some: {} } } });
  check('every paid chargeable invoice has a Payment row', paidChargeable === paidWithLedger,
    `${paidWithLedger} of ${paidChargeable}`);
  const paidWithCache = await prisma.invoice.count({ where: { group_id: groupId, status: 'paid', series: 'chargeable', amount_paid_pennies: { not: null } } });
  check('and a recomputed amount_paid_pennies cache', paidChargeable === paidWithCache, `${paidWithCache} of ${paidChargeable}`);
  // The OTHER direction: the ledger must not invent money on documents that never took any.
  const warrantyWithPayments = await prisma.invoice.count({ where: { group_id: groupId, series: 'warranty', payments: { some: {} } } });
  check('no warranty invoice has a Payment row — the ledger never invents money', warrantyWithPayments === 0, `${warrantyWithPayments}`);
  const withPhone = await prisma.customer.count({ where: { group_id: groupId, phone: { not: null } } });
  const withE164 = await prisma.customer.count({ where: { group_id: groupId, phone: { not: null }, phone_e164: { not: null } } });
  check('every customer with a phone has the derived phone_e164', withPhone === withE164 && withPhone > 0,
    `${withE164} of ${withPhone}`);
} catch (e) {
  check('generation and assertion completed', false, String(e?.message ?? e).slice(0, 300));
} finally {
  // ── TEARDOWN — refused unless the target is provably this run's throwaway ──────────────────────
  if (groupId) {
    console.log('\n— teardown —');
    const g = await prisma.group.findUnique({ where: { id: groupId }, select: { ref: true, is_demo: true, is_internal: true } });
    const safe = g && g.is_demo === true && g.is_internal === true
      && !isListedDemoTenant(g.ref) && g.ref !== 'GB-GD2236';
    if (!safe) {
      check('REFUSING TEARDOWN — the target no longer looks like this run\'s throwaway', false, JSON.stringify(g));
    } else {
      const p0 = Date.now();
      await purgeTenant('generation-gate', groupId);
      const gone = await prisma.group.findUnique({ where: { id: groupId }, select: { id: true } });
      check('teardown purged the throwaway tenant', gone === null, `purge took ${Math.round((Date.now() - p0) / 1000)}s`);
    }
  }
  console.log(`\nRUNTIME: ${Math.round((Date.now() - t0) / 1000)}s total — pre-release only, not per-push`);
  console.log(`\n${out.filter((c) => c === 'F').length} failures of ${out.length}`);
  await prisma.$disconnect();
  process.exit(out.includes('F') ? 1 : 0);
}
