/**
 * File: scripts/demo-generate.mjs
 * Build a demo tenant and CHECK IT THROUGH THE REAL CHOKEPOINTS.
 *
 * The generator computes its own capacity in order to decide how much work to emit. That figure is
 * NOT evidence: it is the generator marking its own homework. Everything asserted below is read
 * back through lib/capacity, lib/charged-labour and lib/utilisation-light — the same code the
 * dashboard runs — so a disagreement between the two is exactly what this catches.
 *
 *   node --experimental-strip-types --import ./scripts/_ts.mjs scripts/demo-generate.mjs [--keep]
 */
import bcrypt from 'bcryptjs';
import { prisma } from '../lib/db.ts';
import { generateDemoTenant, DEMO_SPEC } from '../lib/demo/generate.ts';
import { getGroupUtilisation } from '../lib/capacity.ts';
import { fetchLedgerInvoices, labourGrossMargin, chargedLabourCentihours } from '../lib/charged-labour.ts';
import { utilisationLight, defaultThresholds } from '../lib/utilisation-light.ts';
import { purgeTenant } from '../lib/tenant-purge.ts';

const KEEP = process.argv.includes('--keep');
const SEED = process.env.DEMO_SEED ?? 'slice4-first';
const NOW = process.env.DEMO_NOW ? new Date(process.env.DEMO_NOW) : new Date();

const out = [];
const check = (n, ok, d = '') => { out.push(ok ? 'P' : 'F'); console.log(`${ok ? '✓' : '✗'} ${n}${d ? `  — ${d}` : ''}`); };
const money = (p) => `£${(p / 100).toFixed(2)}`;

const t0 = Date.now();
let groupId = null;

try {
  console.log(`seed=${SEED}  now=${NOW.toISOString()}\n`);
  const res = await generateDemoTenant({
    seed: SEED, now: NOW,
    groupName: 'Marketbridge Motor Works',
    ownerEmail: `demo.owner.${SEED}@example.com`,
    ownerName: 'Sam Okafor',
    ownerPasswordHash: await bcrypt.hash('DemoTenant!2026', 10),
    expiresAt: null,
    onProgress: (step, detail) => console.log(`   … ${step}${detail ? `: ${detail}` : ''}`),
  });
  groupId = res.groupId;
  const secs = ((Date.now() - t0) / 1000).toFixed(0);
  console.log(`\ngenerated in ${secs}s — ${JSON.stringify(res.counts)}`);
  console.log(`generator's own target: ${res.targetChargedHours}h, planned ${res.plannedChargedHours}h`);
  console.log(`generator's elapsed-month view: ${res.elapsedMonthTarget.soldToDate}h / ${res.elapsedMonthTarget.availableToDate}h = ${res.elapsedMonthTarget.ratio}%\n`);

  // ── READ BACK THROUGH THE PRODUCT'S OWN CODE ────────────────────────────────────────────────
  const from = new Date(Date.UTC(NOW.getUTCFullYear() - 1, NOW.getUTCMonth(), NOW.getUTCDate()));
  const to = new Date(Date.UTC(NOW.getUTCFullYear(), NOW.getUTCMonth(), NOW.getUTCDate() + 1));
  const u = await getGroupUtilisation(res.groupId, [res.siteId], { from, to });
  const invoices = await fetchLedgerInvoices({ groupId: res.groupId, siteIds: [res.siteId], from, to });
  const gm = labourGrossMargin(invoices);
  const cl = chargedLabourCentihours(invoices);
  const charged = cl.centihours / 100;
  const effRate = charged > 0 ? gm.revenueNet / charged : 0;

  console.log('── READ BACK (lib/capacity, lib/charged-labour) ──');
  console.log(`  sellable ${u.available.toFixed(1)}h   charged ${u.charged.toFixed(1)}h   ratio ${(u.ratio * 100).toFixed(1)}%`);
  console.log(`  raw ${u.rawHours.toFixed(1)}h   leave ${u.leaveHours.toFixed(1)}h   PH ${u.phHours.toFixed(1)}h   mechanics ${u.mechanicCount}`);
  console.log(`  revenue ${money(gm.revenueNet)}   parts ${money(gm.partsCost)}   margin ${money(gm.grossMargin)} (${(gm.grossMargin / gm.revenueNet * 100).toFixed(1)}%)`);
  console.log(`  effective rate ${money(effRate)}/h   invoices ${invoices.length}\n`);

  check('trailing 12 months lands in the 60–65% band', u.ratio >= 0.60 && u.ratio <= 0.65, `${(u.ratio * 100).toFixed(1)}%`);
  check('capacity config is complete (every mechanic has hours)', u.configComplete === true,
    u.missingHoursMechanics.join(', ') || 'complete');
  check('two chargeable mechanics are counted', u.mechanicCount === DEMO_SPEC.mechanics, String(u.mechanicCount));
  check('leave and public holidays both bite', u.leaveHours > 0 && u.phHours > 0,
    `leave ${u.leaveHours.toFixed(0)}h, PH ${u.phHours.toFixed(0)}h`);
  check('effective rate is near £146/h', effRate / 100 >= 110 && effRate / 100 <= 185, money(effRate));
  check('gross margin is near 72%', gm.grossMargin / gm.revenueNet >= 0.62 && gm.grossMargin / gm.revenueNet <= 0.82,
    `${(gm.grossMargin / gm.revenueNet * 100).toFixed(1)}%`);

  // ── THE LIGHT, at the elapsed day of the current month ───────────────────────────────────────
  const monthStart = new Date(Date.UTC(NOW.getUTCFullYear(), NOW.getUTCMonth(), 1));
  const mu = await getGroupUtilisation(res.groupId, [res.siteId], { from: monthStart, to });
  const light = utilisationLight({ soldToDate: mu.charged, availableToDate: mu.available }, defaultThresholds());
  console.log(`\n  current month to date: ${mu.charged.toFixed(1)}h / ${mu.available.toFixed(1)}h`);
  check('the light is AMBER on the stock thresholds', light?.colour === 'amber',
    `${light?.colour} at ${light?.pct.toFixed(1)}%`);

  // ── SHAPE ────────────────────────────────────────────────────────────────────────────────────
  const cards = await prisma.jobCard.count({ where: { group_id: res.groupId } });
  const forward = await prisma.jobCard.count({ where: { group_id: res.groupId, start_at: { gt: to } } });
  const custs = await prisma.customer.count({ where: { group_id: res.groupId } });
  const realPhones = await prisma.customer.count({ where: { group_id: res.groupId, NOT: { phone: { startsWith: '07700 900' } } } });
  const realEmails = await prisma.customer.count({ where: { group_id: res.groupId, NOT: { email: { endsWith: '@example.com' } } } });
  check('every customer phone is in the reserved range', realPhones === 0, `${realPhones} outside`);
  check('every customer email is example.com', realEmails === 0, `${realEmails} outside`);
  check('there is a forward book', forward > 0, `${forward} cards after today`);
  console.log(`\n  ${cards} job cards, ${custs} customers, ${forward} forward`);

  if (KEEP) {
    const owner = await prisma.user.findFirst({ where: { group_id: res.groupId, is_owner: true }, select: { email: true } });
    console.log(`\nKEPT for inspection: group ${res.groupId}`);
    console.log(`  sign in: ${owner?.email} / DemoTenant!2026`);
    groupId = null; // do not purge
  }
} catch (e) {
  check('run completed', false, String(e?.message ?? e).slice(0, 400));
  console.error(e);
} finally {
  if (groupId) {
    console.log('\npurging…');
    await purgeTenant('slice4-gate', groupId).catch((e) => console.log('purge failed:', e.message.slice(0, 200)));
  }
  console.log(`\n${out.filter((c) => c === 'F').length} failures of ${out.length}`);
  await prisma.$disconnect();
}
