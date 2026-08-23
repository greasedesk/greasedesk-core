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
  // A FOURTH CARD for the identity work. card2 is invoiced by section 5 and refuseBayWrite then
  // refuses the quote endpoint — correctly. One card per question, or a later section inherits an
  // earlier one's end state and fails for a reason that has nothing to do with its subject.
  const card4 = await prisma.jobCard.create({ data: { group_id: ZZ, site_id: site.id, vehicle_id: veh.id,
    customer_id: cust.id, status: 'in_progress' }, select: { id: true } });
  fix = { cust: cust.id, veh: veh.id, card: card.id, card2: card2.id, card4: card4.id };

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
  const saveOn = (cardId, lines) => page.evaluate(async (b) => {
    const r = await fetch('/api/jobcard-quote', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin', body: JSON.stringify(b) });
    return { status: r.status, body: await r.json().catch(() => ({})) };
  }, { jobCardId: cardId, vatRate: 20, items: lines });
  const saveVia = (lines) => saveOn(card2.id, lines);
  const saveId = (lines) => saveOn(card4.id, lines);
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

  // ── 7. A LINE KEEPS ITS IDENTITY ACROSS A SAVE ───────────────────────────────────────────────
  // The claim the whole exercise exists for. Today the save deletes every row and recreates it, so
  // every id changes and anything referencing one is gone.
  console.log('\n— a line survives a save —');
  const idLines = [
    { item_type: 'part', description: 'QLO keep me', qty: 1, unit_price: 30, unit_cost: 10, vatable: true },
    { item_type: 'part', description: 'QLO keep me too', qty: 1, unit_price: 40, unit_cost: 12, vatable: true },
  ];
  await saveId(idLines);
  const firstPass = await prisma.jobCardItem.findMany({ where: { job_card_id: card4.id },
    orderBy: { position: 'asc' }, select: { id: true, description: true, created_at: true } });
  check('two lines saved', firstPass.length === 2, String(firstPass.length));
  const withIds = firstPass.map((r, i) => ({ ...idLines[i], id: r.id }));
  // Re-save the SAME lines, now claiming their ids.
  const rs = await saveId(withIds);
  check('the re-save is accepted', rs.status === 200, `${rs.status} ${JSON.stringify(rs.body).slice(0, 80)}`);
  const secondPass = await prisma.jobCardItem.findMany({ where: { job_card_id: card4.id },
    orderBy: { position: 'asc' }, select: { id: true, description: true, created_at: true } });
  check('the ids are the same rows, not new ones',
    JSON.stringify(secondPass.map((r) => r.id)) === JSON.stringify(firstPass.map((r) => r.id)),
    `${firstPass.map((r) => r.id.slice(0, 8)).join(',')} → ${secondPass.map((r) => r.id.slice(0, 8)).join(',')}`);
  check('  …and created_at is untouched, so they were updated not replaced',
    JSON.stringify(secondPass.map((r) => r.created_at.toISOString())) === JSON.stringify(firstPass.map((r) => r.created_at.toISOString())));

  // ── 8. A SURVIVING LINE KEEPS ITS DueItemLine LINK ───────────────────────────────────────────
  // DueItemLine.job_card_item is onDelete: Cascade, so a delete-and-recreate silently destroys
  // every link on the card. This is why the table has never had a row worth keeping.
  console.log('\n— and so does what points at it —');
  const finding = await prisma.vehicleDueItem.create({ data: {
    group_id: ZZ, vehicle_id: veh.id, found_on_job_card_id: card4.id, description: 'QLO finding for linking',
    due_basis: 'next_service', customer_response: 'not_raised', created_by: 'quote-line-order-gate' }, select: { id: true } });
  fix.finding = finding.id;
  const linkRes = await page.evaluate(async (b) => {
    const r = await fetch('/api/due-items', { method: 'PUT', headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin', body: JSON.stringify(b) });
    return { status: r.status, body: await r.json().catch(() => ({})) };
  }, { dueItemId: finding.id, jobCardItemId: secondPass[0].id });
  check('a finding links to a line', linkRes.status === 200 && linkRes.body.linked === true, JSON.stringify(linkRes));
  check('  …and the link row exists', (await prisma.dueItemLine.count({ where: { due_item_id: finding.id } })) === 1);
  await saveId(withIds);
  check('THE LINK SURVIVES A SAVE',
    (await prisma.dueItemLine.count({ where: { due_item_id: finding.id, job_card_item_id: secondPass[0].id } })) === 1,
    'the cascade destroys it whenever the save recreates the row');

  // ── 9. THE REFUSALS ──────────────────────────────────────────────────────────────────────────
  // Ids are CLAIMS. Each of these is 200 against an implementation that ignores them, which is
  // exactly what today's does — so all four are red before the change and none is vacuous.
  console.log('\n— an id is a claim, not a fact —');
  const dup = await saveId([{ ...idLines[0], id: secondPass[0].id }, { ...idLines[1], id: secondPass[0].id }]);
  check('a payload claiming one id twice is refused', dup.status === 400, `${dup.status} ${dup.body?.code ?? ''}`);

  const otherCard = await saveId([{ ...idLines[0], id: (await prisma.jobCardItem.findFirst({
    where: { job_card_id: card.id }, select: { id: true } }))?.id }]);
  check('an id belonging to another card on this tenant is refused', otherCard.status === 400 || otherCard.status === 409,
    `${otherCard.status} ${otherCard.body?.code ?? ''}`);

  // CROSS-TENANT, read-only: a TMBS line id is SENT, never written to. The write is scoped to the
  // ZZ card in the body, so a permissive implementation cannot reach TMBS — asserted below rather
  // than assumed, because "it cannot" is the sort of claim that expires.
  const tmbsLine = await prisma.jobCardItem.findFirst({
    where: { job_card: { group_id: '854d38e7-6dd4-4836-af61-a0d169639a78' } },
    select: { id: true, description: true, unit_price: true } });
  const foreign = await saveId([{ ...idLines[0], id: tmbsLine.id }]);
  check('an id from another TENANT is refused', foreign.status === 400 || foreign.status === 409 || foreign.status === 404,
    `${foreign.status} ${foreign.body?.code ?? ''}`);
  const tmbsAfter = await prisma.jobCardItem.findUnique({ where: { id: tmbsLine.id },
    select: { description: true, unit_price: true, job_card_id: true } });
  check('  …and the TMBS line is untouched, whatever the answer was',
    tmbsAfter?.description === tmbsLine.description && String(tmbsAfter?.unit_price) === String(tmbsLine.unit_price),
    'the write is scoped to the card in the body; this asserts it rather than trusting it');

  const ghost = await saveId([{ ...idLines[0], id: '00000000-0000-4000-8000-000000000000' }]);
  check('an id that no longer exists is a 409, not a silent add', ghost.status === 409,
    `${ghost.status} ${ghost.body?.code ?? ''} — the estimate changed underneath, which is the lost-update case`);

  // ── 10. THE COST AUDIT TELLS TWO IDENTICAL LINES APART ───────────────────────────────────────
  // Keyed by (item_type, description) today, first occurrence wins, so a change to the SECOND of
  // two identical lines is compared against the FIRST's cost and reported wrong.
  console.log('\n— two lines that read the same —');
  const twin = (cost) => ({ item_type: 'part', description: 'QLO twin', qty: 1, unit_price: 50, unit_cost: cost, vatable: true });
  await saveId([twin(40), twin(90)]);
  const twinRows = await prisma.jobCardItem.findMany({ where: { job_card_id: card4.id, description: 'QLO twin' },
    orderBy: { position: 'asc' }, select: { id: true } });
  check('two identical descriptions are two rows', twinRows.length === 2, String(twinRows.length));
  const auditWas = await prisma.auditLog.count({ where: { entity_id: card4.id, action: 'quote.cost_entered' } });
  await saveId([{ ...twin(40), id: twinRows[0].id }, { ...twin(125), id: twinRows[1].id }]);
  const twinAudit = await prisma.auditLog.findMany({ where: { entity_id: card4.id, action: 'quote.cost_entered' },
    orderBy: { created_at: 'desc' }, take: 2, select: { diff_json: true } });
  const fresh = twinAudit.slice(0, (await prisma.auditLog.count({ where: { entity_id: card4.id, action: 'quote.cost_entered' } })) - auditWas);
  check('changing the SECOND twin writes one row', fresh.length === 1, `${fresh.length} rows`);
  check('  …reporting ITS old cost, not the first twin\'s',
    Number(fresh[0]?.diff_json?.from) === 90 && Number(fresh[0]?.diff_json?.to) === 125,
    `${JSON.stringify(fresh[0]?.diff_json)} — 40 would be the first twin's, which is the blind spot`);

  // ── 11. WHAT "MATERIAL" MEANS IS UNCHANGED BY ANY OF THIS ────────────────────────────────────
  // Pure, and green both sides: the bag comparison never looked at rows as identities. Asserted
  // because position now moves on a reorder and in-place edits are about to exist.
  console.log('\n— the customer sees values, not rows —');
  const V = await import('../lib/quote-version.ts');
  const base = [{ description: 'A', qty: 1, unit_price: 10, vat_rate: 20 },
                { description: 'B', qty: 2, unit_price: 20, vat_rate: 20 }];
  check('a pure reorder is immaterial', V.quoteMateriallyUnchanged(base, [base[1], base[0]], true),
    'position changes, the customer document does not');
  check('swapping two descriptions in place is immaterial',
    V.quoteMateriallyUnchanged(base, [{ ...base[0], description: 'B', qty: 2, unit_price: 20 },
                                      { ...base[1], description: 'A', qty: 1, unit_price: 10 }], true),
    'the same bag arrives in different rows — the offer is unchanged');
  check('  …while a real price change is NOT immaterial',
    !V.quoteMateriallyUnchanged(base, [base[0], { ...base[1], unit_price: 21 }], true),
    'the discriminating half — without it the two above pass on a broken comparison');

  // ── 12. THE JUNE GOLDEN IS UNMOVED — VERIFIED, NOT REISSUED ──────────────────────────────────
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
    await step('links', () => prisma.dueItemLine.deleteMany({ where: { group_id: ZZ } }));
    await step('finding', () => fix.finding ? prisma.vehicleDueItem.deleteMany({ where: { id: fix.finding } }) : null);
    await step('items', () => prisma.jobCardItem.deleteMany({ where: { job_card_id: { in: [fix.card, fix.card2, fix.card3, fix.card4].filter(Boolean) } } }));
    await step('cards', () => prisma.jobCard.deleteMany({ where: { group_id: ZZ, id: { in: [fix.card, fix.card2, fix.card3, fix.card4].filter(Boolean) } } }));
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
        + await prisma.jobCard.count({ where: { group_id: ZZ, id: { in: [fix.card, fix.card2, fix.card3, fix.card4].filter(Boolean) } } });
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
