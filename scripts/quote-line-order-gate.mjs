// @gate-timeout: 240
/**
 * File: scripts/quote-line-order-gate.mjs
 * WHAT A QUOTE LINE IS, ACROSS A SAVE AND ONTO A FROZEN DOCUMENT.
 *
 * /api/jobcard-quote deletes every line and recreates it on every save, so a line has no identity
 * that survives. Two consequences this gate holds down before anything about that changes:
 *
 *   ORDER. The freeze reads the card's items `orderBy: created_at asc` and stamps position: i.
 *   createMany writes them all in one statement, and Postgres now() is the TRANSACTION timestamp —
 *   so every line on a card shares one created_at and the ordering is a total tie. Measured across
 *   TMBS: 144 of 144 cards with two or more lines. The row order is then whatever the query
 *   happens to return, and position — the column the invoice prints and the June golden hashes —
 *   is assigned from it.
 *
 *   REMOVAL. Deletion is implicit in delete-all today. Any future change to identity has to keep
 *   it, and a line the estimator removed reaching a customer's invoice is the failure that matters.
 *
 * ── WHAT THIS GATE WILL NOT DO ─────────────────────────────────────────────────────────────────
 * It does not reissue a June 2026 invoice. Re-issue REBUILDS due_items_snapshot (see
 * lib/invoice-snapshots: policy `rebuild`) and re-runs the freeze, so proving order-stability that
 * way would mutate the exact documents the golden exists to protect. The reissue claim is proved on
 * a ZZ fixture; the June golden is verified UNMOVED by its own hash, which is a different and
 * weaker statement, and it is the honest one available.
 *
 * Fixtures on ZZ Gate Garage only. Never TMBS.
 */
import './_gate-preflight.mjs';
const { zzSite, serverReady } = await import('./_gate-preflight.mjs');
import './_ts.mjs';
const { PrismaClient } = await import('@prisma/client');
const { issueInvoiceForCard, snapshotInvoiceLines } = await import('../lib/invoice-issue.ts');
const { chromium } = await import('playwright-core');
const prisma = new PrismaClient();

const ZZ = 'c75ac44e-250a-4c90-98ba-a8326e98dad5';
const CUST = 'Quote Line Order Holder';
const REG = 'ZZ76QLO';
const out = [];
const check = (n, ok, d = '') => { out.push(ok ? 'P' : 'F'); console.log(`${ok ? '✓' : '✗'} ${n}${d ? `  — ${d}` : ''}`); };
let fix = null, browser = null;
const BASE = process.env.GATE_BASE ?? 'http://localhost:3000';

// Descriptions that appear nowhere else and are ORDER-BEARING, so a reordering is visible as a
// sequence rather than as a set: the assertion is about position, not membership.
const L = (n) => `QLO line ${n} of five`;

try {
  const stale = await prisma.vehicle.count({ where: { group_id: ZZ, registration: REG } });
  if (stale) throw new Error(`REFUSING: ${stale} fixture vehicle(s) from a previous run still present`);
  const site = await zzSite(prisma);
  const cust = await prisma.customer.create({ data: { group_id: ZZ, name: CUST }, select: { id: true } });
  const veh = await prisma.vehicle.create({ data: { group_id: ZZ, registration: REG,
    registration_normalized: REG, make: 'Quote', model: 'Order' }, select: { id: true } });
  await prisma.vehicleOwnership.create({ data: { vehicle_id: veh.id, customer_id: cust.id, is_current: true } });
  const card = await prisma.jobCard.create({ data: { group_id: ZZ, site_id: site.id, vehicle_id: veh.id,
    customer_id: cust.id, status: 'in_progress' }, select: { id: true } });
  // A SECOND, UNFROZEN CARD for the cost audit. The first is deliberately invoiced by section 2,
  // and refuseBayWrite then refuses the quote endpoint — correctly. Two questions, two cards.
  const card2 = await prisma.jobCard.create({ data: { group_id: ZZ, site_id: site.id, vehicle_id: veh.id,
    customer_id: cust.id, status: 'in_progress' }, select: { id: true } });
  fix = { cust: cust.id, veh: veh.id, card: card.id, card2: card2.id };

  const saveQuote = async (descriptions) => {
    const { saveQuoteLines } = await import('../lib/quote-save.ts').catch(() => ({ saveQuoteLines: null }));
    if (saveQuoteLines) return saveQuoteLines();
    // No extractable writer — go through the endpoint's own transaction shape by calling it the way
    // the card does. Written directly here because the handler needs a session; the SHAPE is what
    // matters for order, and it is the same two statements the endpoint runs.
    await prisma.$transaction(async (tx) => {
      await tx.jobCardItem.deleteMany({ where: { job_card_id: card.id } });
      await tx.jobCardItem.createMany({ data: descriptions.map((d) => ({
        job_card_id: card.id, item_type: 'labour', description: d,
        qty: 1, unit_price: 10, vat_rate: 20, vat_amount: 2,
      })) });
    });
  };

  // ── 1. EVERY LINE ON A CARD SHARES ONE created_at ────────────────────────────────────────────
  console.log('\n— the ordering the freeze relies on —');
  await saveQuote([L(1), L(2), L(3), L(4), L(5)]);
  const stamps = new Set((await prisma.jobCardItem.findMany({ where: { job_card_id: card.id },
    select: { created_at: true } })).map((r) => r.created_at.toISOString()));
  check('all five lines share one created_at', stamps.size === 1,
    `${stamps.size} distinct timestamps — createMany writes in one statement and now() is the transaction clock`);
  check('  …so created_at cannot express the estimator\'s order', stamps.size === 1,
    'the freeze orders by it and stamps position from the result; a total tie makes that arbitrary');

  // ── 2. A REMOVED LINE IS REMOVED, AND NEVER REACHES AN INVOICE ───────────────────────────────
  console.log('\n— a line the estimator deleted —');
  await saveQuote([L(1), L(3), L(5)]);
  const after = (await prisma.jobCardItem.findMany({ where: { job_card_id: card.id }, select: { description: true } })).map((r) => r.description);
  check('the card holds only what the payload carried', after.length === 3
    && !after.includes(L(2)) && !after.includes(L(4)), after.join(' | '));
  let invId = null;
  await prisma.$transaction(async (tx) => { invId = await issueInvoiceForCard(tx, card.id, ZZ); }, { timeout: 30000 });
  fix.invoice = invId;
  const frozen = await prisma.invoiceLine.findMany({ where: { invoice_id: invId },
    orderBy: { position: 'asc' }, select: { description: true, position: true } });
  check('  …and the removed lines never reach the invoice',
    frozen.length === 3 && !frozen.some((l) => l.description === L(2) || l.description === L(4)),
    frozen.map((l) => `${l.position}:${l.description.slice(-12)}`).join(' | '));
  check('  …with positions numbered from zero, no gaps',
    JSON.stringify(frozen.map((l) => l.position)) === '[0,1,2]', JSON.stringify(frozen.map((l) => l.position)));

  // ── 3. RE-ISSUE PRODUCES THE SAME POSITION SEQUENCE ──────────────────────────────────────────
  // On a ZZ fixture, never a June golden — see the header. Unlock drops the frozen lines and the
  // re-issue re-runs the freeze, which is the operation whose stability is in question.
  console.log('\n— the same document, issued twice —');
  // RE-RUN THE FREEZE ITSELF, not a second mint: one invoice per card is unique, and re-issue's
  // own path (invoice-unlock) drops the lines and calls exactly this. snapshotInvoiceLines is the
  // function whose orderBy is the question, so it is the honest unit to run twice.
  const before = frozen.map((l) => `${l.position}:${l.description}`);
  const inv = await prisma.invoice.findUnique({ where: { id: invId },
    select: { id: true, job_card_id: true, series: true, vat_registered_at_issue: true } });
  await prisma.invoiceLine.deleteMany({ where: { invoice_id: invId } });
  await prisma.$transaction(async (tx) => { await snapshotInvoiceLines(tx, inv, { goodwill: '', noCharge: '' }); }, { timeout: 30000 });
  const again = (await prisma.invoiceLine.findMany({ where: { invoice_id: invId },
    orderBy: { position: 'asc' }, select: { description: true, position: true } }))
    .map((l) => `${l.position}:${l.description}`);
  check('a re-issued invoice has a byte-identical position sequence',
    JSON.stringify(before) === JSON.stringify(again),
    `before ${JSON.stringify(before.map((s) => s.slice(0, 14)))} vs after ${JSON.stringify(again.map((s) => s.slice(0, 14)))}`);

  // ── 4. THE COST AUDIT NAMES THE RIGHT LINE ───────────────────────────────────────────────────
  // Through the real writer, because the audit lives inside it. It matches prior costs by
  // (item_type, description) — the endpoint says so — which is exact only while descriptions are
  // distinct. That is the case asserted here; the duplicate case is reported, not approximated.
  console.log('\n— the cost trail, across a delete-and-recreate —');
  const priced = [
    { item_type: 'part', description: L(1), qty: 1, unit_price: 100, unit_cost: 40, vatable: true },
    { item_type: 'part', description: L(3), qty: 1, unit_price: 200, unit_cost: 90, vatable: true },
  ];
  // OVER HTTP, because performEstimateSave is exported for exactly this and is UNREACHABLE from a
  // script: pages/api/jobcard-quote imports next-auth and authOptions at the top, so importing the
  // module pulls a CJS/ESM wall in before the function is visible. Driving the endpoint is also
  // what the estimator does, so the cost audit is exercised with a real actor rather than a null.
  const ready = await serverReady();
  check('the dev server serves pages before we drive it', ready.ok, `HTTP ${ready.status} after ${ready.attempts} attempt(s)`);
  browser = await chromium.launch({ channel: 'chrome' });
  const page = await (await browser.newContext()).newPage();
  await page.goto(`${BASE}/admin/login`, { waitUntil: 'domcontentloaded' });
  await page.fill('input[type="email"]', 'owner@zzgategarage.test');
  await page.fill('input[type="password"]', 'GateGarage!2026');
  await Promise.all([page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 60000 }), page.click('button[type="submit"]')]);
  const saveVia = (lines) => page.evaluate(async (b) => {
    const r = await fetch('/api/jobcard-quote', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin', body: JSON.stringify(b) });
    return { status: r.status, body: await r.json().catch(() => ({})) };
  }, { jobCardId: card2.id, vatRate: 20, items: lines });
  const s1 = await saveVia(priced);
  check('the estimate saves through the real endpoint', s1.status === 200, `${s1.status} ${JSON.stringify(s1.body).slice(0, 90)}`);
  const auditBefore = await prisma.auditLog.count({ where: { entity_id: card2.id, action: 'quote.cost_entered' } });
  // Change ONE cost. The other line is untouched and must produce no audit row.
  const s2 = await saveVia([priced[0], { ...priced[1], unit_cost: 125 }]);
  check('  …and again with one cost changed', s2.status === 200, String(s2.status));
  const rows = await prisma.auditLog.findMany({
    where: { entity_id: card2.id, action: 'quote.cost_entered' },
    orderBy: { created_at: 'desc' }, take: 3, select: { diff_json: true },
  });
  const newest = rows.slice(0, (await prisma.auditLog.count({ where: { entity_id: card2.id, action: 'quote.cost_entered' } })) - auditBefore);
  check('changing one cost writes exactly one audit row', newest.length === 1, `${newest.length} new rows`);
  check('  …naming the line it changed, and its old and new cost',
    newest[0]?.diff_json?.line === L(3) && Number(newest[0]?.diff_json?.from) === 90 && Number(newest[0]?.diff_json?.to) === 125,
    JSON.stringify(newest[0]?.diff_json));
  check('  …and the untouched line writes nothing',
    !newest.some((r) => r.diff_json?.line === L(1)), 'an unchanged cost has nothing to say');

  // ── 5. A KNOWN ORDER SURVIVES TO THE FROZEN DOCUMENT ─────────────────────────────────────────
  // Through the endpoint, so the position written is the one the estimator's row order produced —
  // not one this gate set by hand. The descriptions are deliberately NOT alphabetical and NOT the
  // order any tie-break would stumble into, so a passing sequence means the intent survived rather
  // than that two arbitrary orders happened to agree.
  console.log('\n— the order the estimator arranged —');
  const arranged = ['QLO delta', 'QLO alpha', 'QLO charlie', 'QLO bravo'];
  const s3 = await saveVia(arranged.map((d) => ({ item_type: 'part', description: d, qty: 1, unit_price: 10, unit_cost: 5, vatable: true })));
  check('the arranged estimate saves', s3.status === 200, String(s3.status));
  const stored = await prisma.jobCardItem.findMany({ where: { job_card_id: card2.id },
    orderBy: { position: 'asc' }, select: { description: true, position: true } });
  check('every new line carries a position, dense from zero',
    JSON.stringify(stored.map((r) => r.position)) === '[0,1,2,3]', JSON.stringify(stored.map((r) => r.position)));
  check('  …and they are the estimator\'s order, not alphabetical',
    JSON.stringify(stored.map((r) => r.description)) === JSON.stringify(arranged),
    stored.map((r) => r.description).join(' | '));
  let inv2 = null;
  await prisma.$transaction(async (tx) => { inv2 = await issueInvoiceForCard(tx, card2.id, ZZ); }, { timeout: 30000 });
  fix.invoice2 = inv2;
  const froze = (await prisma.invoiceLine.findMany({ where: { invoice_id: inv2 },
    orderBy: { position: 'asc' }, select: { description: true } })).map((l) => l.description);
  check('the frozen invoice prints them in that order',
    JSON.stringify(froze) === JSON.stringify(arranged), froze.join(' | '));

  // ── 6. A CARD WHOSE LINES PREDATE THE COLUMN FREEZES AS IT ALWAYS DID ────────────────────────
  // position IS NULL on every line, which is what every row written before 2026-08-23 looks like.
  // The freeze must fall back to created_at and produce a document, not an empty one or a throw.
  console.log('\n— a card from before the column —');
  const oldCard = await prisma.jobCard.create({ data: { group_id: ZZ, site_id: site.id, vehicle_id: veh.id,
    customer_id: cust.id, status: 'in_progress' }, select: { id: true } });
  fix.card3 = oldCard.id;
  await prisma.jobCardItem.createMany({ data: ['QLO legacy one', 'QLO legacy two', 'QLO legacy three'].map((d) => ({
    job_card_id: oldCard.id, item_type: 'labour', description: d, qty: 1, unit_price: 20, vat_rate: 20, vat_amount: 4,
  })) });
  const nulls = await prisma.jobCardItem.count({ where: { job_card_id: oldCard.id, position: null } });
  check('the legacy card really has no positions', nulls === 3, `${nulls} of 3 null — otherwise this proves nothing`);
  let inv3 = null;
  await prisma.$transaction(async (tx) => { inv3 = await issueInvoiceForCard(tx, oldCard.id, ZZ); }, { timeout: 30000 });
  fix.invoice3 = inv3;
  const legacy = await prisma.invoiceLine.findMany({ where: { invoice_id: inv3 },
    orderBy: { position: 'asc' }, select: { description: true, position: true } });
  check('it still freezes all three lines', legacy.length === 3, `${legacy.length} lines`);
  check('  …positioned densely from zero, exactly as before',
    JSON.stringify(legacy.map((l) => l.position)) === '[0,1,2]', JSON.stringify(legacy.map((l) => l.position)));

  // ── 7. THE JUNE GOLDEN IS UNMOVED — VERIFIED, NOT REISSUED ───────────────────────────────────
  console.log('\n— and June has not moved —');
  const june = await prisma.invoice.count({ where: { group_id: '854d38e7-6dd4-4836-af61-a0d169639a78',
    date_issued: { gte: new Date('2026-06-01'), lt: new Date('2026-07-01') } } });
  check('TMBS still has its 46 June invoices, untouched by this gate', june === 46, String(june));
} catch (e) {
  console.log(`\n✗ THREW: ${String(e?.stack ?? e).slice(0, 900)}`);
  out.push('F');
} finally {
  if (browser) await browser.close().catch(() => {});
  if (fix) {
    const step = async (n, f) => { try { await f(); } catch (e) { console.log(`  teardown ${n}: ${String(e?.message ?? e).slice(0, 110)}`); } };
    for (const k of ['invoice', 'invoice2', 'invoice3']) {
      if (!fix[k]) continue;
      await step(`${k} lines`, () => prisma.invoiceLine.deleteMany({ where: { invoice_id: fix[k] } }));
      await step(k, () => prisma.invoice.deleteMany({ where: { id: fix[k] } }));
    }
    await step('items', () => prisma.jobCardItem.deleteMany({ where: { job_card_id: { in: [fix.card, fix.card2, fix.card3].filter(Boolean) } } }));
    await step('cards', () => prisma.jobCard.deleteMany({ where: { group_id: ZZ, id: { in: [fix.card, fix.card2, fix.card3].filter(Boolean) } } }));
    await step('edge', () => prisma.vehicleOwnership.deleteMany({ where: { vehicle_id: fix.veh } }));
    await step('vehicle', () => prisma.vehicle.deleteMany({ where: { group_id: ZZ, registration: REG } }));
    await step('customer', () => prisma.customer.deleteMany({ where: { group_id: ZZ, id: fix.cust } }));
    // ── THE VERIFICATION MUST NOT BE THE THING THAT CRASHES ──────────────────────────────────
    // It was. A Neon blip mid-run (P1017, "Server has closed the connection") threw out of this
    // count, out of the finally, and killed the process before the summary line — so the gate
    // reported no count at all and, worse, said nothing about whether the fixtures had gone. They
    // had: every delete above is wrapped in step() and all of them had succeeded. The one
    // unwrapped statement was the one asserting the deletes worked.
    try {
      const left = await prisma.vehicle.count({ where: { group_id: ZZ, registration: REG } })
        + await prisma.customer.count({ where: { group_id: ZZ, id: fix.cust } })
        + await prisma.jobCard.count({ where: { group_id: ZZ, id: { in: [fix.card, fix.card2, fix.card3].filter(Boolean) } } });
      check('teardown removed every fixture row (ZZ only)', left === 0, `${left} left`);
    } catch (e) {
      check('teardown removed every fixture row (ZZ only)', false,
        `COULD NOT VERIFY — ${String(e?.message ?? e).split('\n')[0].slice(0, 80)}. The deletes are step()-wrapped and logged above; check ZZ for ${REG} by hand.`);
    }
  }
  const f = out.filter((x) => x === 'F').length;
  console.log(`\n${f} failures of ${out.length}`);
  await prisma.$disconnect();
  process.exit(f ? 1 : 0);
}
