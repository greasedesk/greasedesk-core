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
import { getSetupSignals } from '../lib/setup-signals.ts';
import { uncostedParts } from '../lib/charged-labour.ts';
import { computeQuotesMetrics } from '../lib/quotes-metrics.ts';
import { wipCardsWhere, wipCardValuePennies } from '../lib/wip.ts';
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

  // ── PRODUCTS: a positive margin on every priced item, and no data-quality warning ───────────
  const items = await prisma.catalogueItem.findMany({
    where: { group_id: res.groupId },
    select: { code: true, name: true, item_type: true, unit_price: true, base_price_ex_vat: true, unit_cost: true },
  });
  const priceOf = (i) => Number(i.item_type === 'fixed' ? (i.base_price_ex_vat ?? 0) : i.unit_price);
  const zeroPriced = items.filter((i) => priceOf(i) <= 0);
  const negative = items.filter((i) => priceOf(i) - Number(i.unit_cost ?? 0) <= 0);
  // The screen's own rule: non-labour, priced, and NO cost recorded. A £0 cost is legitimate.
  const uncosted = items.filter((i) => i.item_type !== 'labour' && i.unit_cost == null && priceOf(i) > 0);
  check('every catalogue item has a base price', zeroPriced.length === 0,
    zeroPriced.length ? zeroPriced.map((i) => i.name).slice(0, 4).join(', ') : `${items.length} items priced`);
  check('every catalogue item has a POSITIVE margin', negative.length === 0,
    negative.length ? negative.map((i) => `${i.name} ${money(priceOf(i) * 100)}−${money(Number(i.unit_cost ?? 0) * 100)}`).join(', ') : 'all positive');
  check('nothing trips the uncosted warning', uncosted.length === 0,
    uncosted.length ? uncosted.map((i) => i.name).join(', ') : 'no banner');

  // ── PAYMENTS: mostly settled, a believable tail ──────────────────────────────────────────────
  const all = await prisma.invoice.findMany({
    where: { group_id: res.groupId }, select: { status: true, series: true, paid_at: true, payment_method_snapshot: true, issued_at: true, lines: { select: { qty: true, unit_price: true } } },
  });
  const chargeable = all.filter((i) => i.series !== 'warranty');
  const paid = chargeable.filter((i) => i.status === 'paid');
  const openInv = chargeable.filter((i) => i.status === 'issued');
  const total = (i) => i.lines.reduce((s2, l) => s2 + Number(l.qty) * Number(l.unit_price) * 100, 0);
  const debt = openInv.reduce((s2, i) => s2 + total(i), 0);
  const paidPct = (paid.length / chargeable.length) * 100;
  console.log(`\n  invoices: ${paid.length} paid, ${openInv.length} outstanding of ${chargeable.length} chargeable  (debtors ${money(debt)})`);
  check('most invoices are paid', paidPct >= 88, `${paidPct.toFixed(1)}%`);
  check('but not all — there is a real chase list', openInv.length >= 3, `${openInv.length} open`);
  check('debtors are a believable figure, not a year of trade', debt < 25_000_00, money(debt));
  check('every paid invoice records a date and a method',
    paid.every((i) => i.paid_at && i.payment_method_snapshot), 'complete');
  check('no payment is dated in the future', paid.every((i) => i.paid_at <= NOW), 'none');
  // ── COMEBACKS. This check used to pass vacuously: "every warranty invoice is settled" is true
  // when there are none, and there were none — 29 comeback cards had been billed at full retail.
  // Assert the population EXISTS before asserting anything about it.
  const warranty = all.filter((i) => i.series === 'warranty');
  const comebackCards = await prisma.jobCard.count({ where: { group_id: res.groupId, is_comeback: true } });
  check('comeback cards exist at all', comebackCards > 0, `${comebackCards} cards`);
  check('every comeback minted a WARRANTY invoice, not a bill', warranty.length === comebackCards,
    `${warranty.length} warranty vs ${comebackCards} comebacks`);
  check('warranty invoices are settled, never paid, and total £0',
    warranty.length > 0 && warranty.every((i) => i.status === 'settled' && Math.abs(total(i)) < 1),
    warranty.length ? `${warranty.length} settled at £0` : 'NONE — vacuous');

  // ── UNCOSTED PARTS: the P&L's own exposure read, not my arithmetic ──────────────────────────
  const exposure = uncostedParts(invoices);
  check('the P&L sees NO uncosted parts', exposure.lines === 0,
    exposure.lines ? `${exposure.lines} lines, ${money(exposure.retailPennies)} retail across ${exposure.invoices.length} invoices` : 'clean');
  // The JOB CARD line is where the catalogue link lives. An invoice snapshotted from an accepted
  // quote version carries catalogue_item_id: null BY DESIGN — "the frozen line is the record; the
  // product link is not re-resolved" — so asserting it on the invoice would be asserting against
  // the product. Asserted where it is actually true, and where the estimate screen reads it.
  const linkedCard = await prisma.jobCardItem.count({ where: { job_card: { is: { group_id: res.groupId } }, catalogue_item_id: { not: null } } });
  const allCard = await prisma.jobCardItem.count({ where: { job_card: { is: { group_id: res.groupId } } } });
  check('job-card lines carry their catalogue id', linkedCard > allCard * 0.4, `${linkedCard} of ${allCard} linked`);
  // And the invoice's own defence: a real, non-zero cost on every part-ish line.
  const zeroCostLines = await prisma.invoiceLine.count({
    where: { invoice: { is: { group_id: res.groupId } }, item_type: { not: 'labour' }, unit_price: { gt: 0 }, OR: [{ unit_cost: null }, { unit_cost: 0 }] },
  });
  check('no priced invoice line has a zero or absent cost', zeroCostLines === 0, `${zeroCostLines} lines`);

  // ── WIP: a real figure against the open cards ────────────────────────────────────────────────
  const wipCards = await prisma.jobCard.findMany({
    where: wipCardsWhere([res.siteId]),
    select: { is_comeback: true, labour_bill_numeric: true, parts_bill_numeric: true },
  });
  const wipPennies = wipCards.reduce((s2, c) => s2 + wipCardValuePennies(c), 0);
  console.log(`\n  WIP: ${wipCards.length} open cards worth ${money(wipPennies)}`);
  check('there are open cards', wipCards.length > 0, `${wipCards.length}`);
  check('WIP carries a real value, not £0', wipPennies > 0, money(wipPennies));

  // ── QUOTES: a believable conversion rate ─────────────────────────────────────────────────────
  const qm = await computeQuotesMetrics({ groupId: res.groupId, siteIds: [res.siteId], from, to });
  console.log(`  quotes: ${qm.cohortSentCount} sent, ${qm.cohortAcceptedCount} accepted, ${qm.declinedCount} declined, ${qm.expiredCount} expired  → ${qm.conversionPct}%`);
  check('quotes exist at all', qm.cohortSentCount > 0, `${qm.cohortSentCount} sent`);
  check('the conversion rate is believable (50–75%)', qm.conversionPct !== null && qm.conversionPct >= 50 && qm.conversionPct <= 75,
    `${qm.conversionPct}%`);
  check('there are declines AND expiries, not just wins', qm.declinedCount > 0 && qm.expiredCount > 0,
    `${qm.declinedCount} declined, ${qm.expiredCount} expired`);
  const superseded = await prisma.quoteVersion.count({ where: { group_id: res.groupId, status: 'superseded' } });
  check('some declines were re-quoted (supersede history)', superseded > 0, `${superseded} superseded versions`);

  // ── THE QUOTES SCREEN, not just the metrics. The two read different things by design, and the
  // list is the one an owner clicks: a tab reading (0) looks broken whatever the tile says.
  const { listQuotes } = await import('../lib/quotes-list.ts');
  const rows = await listQuotes({ groupId: res.groupId, siteIds: [res.siteId], now: NOW });
  const byStatus = {};
  for (const row of rows) byStatus[row.status] = (byStatus[row.status] ?? 0) + 1;
  console.log(`  quotes screen: ${JSON.stringify(byStatus)}`);
  check('the Declined tab is not empty', (byStatus.declined ?? 0) > 0, `${byStatus.declined ?? 0}`);
  check('the Accepted & booked tab is not empty', (byStatus.accepted_booked ?? 0) > 0, `${byStatus.accepted_booked ?? 0}`);
  check('the live pipeline is a pipeline, not a backlog', (byStatus.awaiting ?? 0) > 0 && (byStatus.awaiting ?? 0) <= 25,
    `${byStatus.awaiting ?? 0} awaiting`);
  // The tab that exists to catch agreed work nobody has scheduled. Empty teaches the opposite.
  check('the Accepted (unbooked) tab is not empty', (byStatus.accepted ?? 0) > 0, `${byStatus.accepted ?? 0}`);

  // The dashboard tile is PERIOD-scoped and the demo lands on the current month, so that is the
  // number an owner actually sees first.
  const mq = await computeQuotesMetrics({ groupId: res.groupId, siteIds: [res.siteId], from: monthStart, to });
  console.log(`  this month: ${mq.cohortSentCount} issued, ${mq.cohortAcceptedCount} accepted → ${mq.conversionPct}%`);
  check('the CURRENT MONTH conversion is not embarrassing', mq.conversionPct !== null && mq.conversionPct >= 45,
    `${mq.conversionPct}%`);

  // ── SETUP: every signal complete ─────────────────────────────────────────────────────────────
  const setup = await getSetupSignals(res.groupId, res.siteId);
  const todo = setup.signals.filter((x) => x.state === 'todo');
  check('every setup signal reads complete', setup.allDone === true,
    todo.length ? `outstanding: ${todo.map((x) => x.key).join(', ')}` : `${setup.doneCount}/${setup.applicableCount}`);

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
