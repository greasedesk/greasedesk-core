/**
 * File: scripts/sale-invoice-gate.mjs
 * @gate-requires: db, server
 *
 * THE SALE INVOICE — step 1: the series, and the VAT position.
 *
 * A car sold out of stock produces a VAT document with a SECOND ORIGIN: it hangs off a
 * StockDisposal, not a job card. This gate covers the two things that must be right before any such
 * document can be minted — which counter and prefix it uses, and which VAT treatment it carries.
 *
 * ── WHAT THE SERIES IS NOT ──────────────────────────────────────────────────────────────────────
 * The series is not a statement about VAT. A margin-scheme car and a qualifying one are both
 * `vehicle_sale` and are taxed on entirely different bases, so nothing may infer the treatment from
 * the series. Invoice.vat_position carries it.
 *
 * ── THE DEFECT FOUND ON THE WAY IN ──────────────────────────────────────────────────────────────
 * `vatPositionFor` took the disposal KIND alone and returned 'margin' for every sale. That is right
 * for a margin car and wrong for a qualifying one by a sixth of the whole purchase price: a
 * qualifying car had its input tax reclaimed at purchase, so output tax is due on the FULL selling
 * price and is not floored at zero. LATENT, never computed: when this was fixed every StockItem in
 * the database was `margin` and no disposal existed anywhere. `vatStatus` is now a required argument
 * with no default, so the omission cannot come back quietly.
 */
import './_gate-preflight.mjs';
const { gatePrisma, describeError, ZZ_GROUP, gateOrigin, serverReady } = await import('./_gate-preflight.mjs');
const { chromium } = await import('/Users/hugh/Developer/greasedesk-core/node_modules/playwright-core/index.mjs');
import './_ts.mjs';

const out = [];
const check = (n, ok, d = '') => { out.push(ok ? 'P' : 'F'); console.log(`${ok ? '✓' : '✗'} ${n}${d ? `  — ${d}` : ''}`); };
const PREFIX = 'ZZSALE';
const { readFileSync } = await import('node:fs');
const gbp = (p) => (p == null ? 'null' : `£${(p / 100).toFixed(2)}`);

const S = await import('/Users/hugh/Developer/greasedesk-core/lib/stock.ts');
const NUM = await import('/Users/hugh/Developer/greasedesk-core/lib/invoice-number.ts');

let prisma;
let browser = null;
try {
  prisma = await gatePrisma();
  /**
   * THE DRIFT CHECK RUNS FIRST, AND DELIBERATELY. It used to sit third, behind the prefix loop — and
   * when the union was mutated to prove it, `prefixForSeries` threw on the unknown series and ended
   * the gate at clause 1 of 30, so the clause that names the defect never ran. A gate that throws
   * reports the prefix it reached, not the clauses it has. Cheapest and most fundamental first.
   *
   * A 6-vs-5 mismatch between these two has already cost a 500 and a two-hour outbox retry here, and
   * tsc cannot see the database's side of it.
   */
  const pg = await prisma.$queryRaw`
    SELECT e.enumlabel AS label FROM pg_enum e
    JOIN pg_type t ON t.oid = e.enumtypid WHERE t.typname = 'InvoiceSeries' ORDER BY e.enumsortorder`;
  const dbSeries = pg.map((r) => r.label);
  check('the TypeScript series union matches the database enum exactly',
    JSON.stringify([...NUM.INVOICE_SERIES].sort()) === JSON.stringify([...dbSeries].sort()),
    `ts=[${[...NUM.INVOICE_SERIES].join(' ')}]  pg=[${dbSeries.join(' ')}]`);

  console.log('\n— FOUR SERIES, FOUR PREFIXES, NO FALLTHROUGH —');
  const profile = {
    invoice_prefix: 'INV', invoice_warranty_prefix: 'W', invoice_historical_prefix: 'H',
    invoice_vehicle_sale_prefix: 'VS', invoice_pad_width: 4, invoice_fy_digits: 2, fy_start_month: 4,
  };
  // NEVER THROWS: a series with no entry reports as MISSING and fails the clause below, rather than
  // ending the run before the rest of the gate exists.
  const prefixOf = (name) => { try { return NUM.prefixForSeries(name, profile); } catch { return 'MISSING'; } };
  const prefixes = NUM.INVOICE_SERIES.map(prefixOf);
  check('every series names its own prefix, and none is missing one',
    new Set(prefixes).size === NUM.INVOICE_SERIES.length && !prefixes.includes('MISSING'),
    NUM.INVOICE_SERIES.map((s, i) => `${s}=${prefixes[i]}`).join(', '));
  /**
   * THE FALLTHROUGH THIS REPLACED. The prefix was a ternary chain ending in `invoice_prefix`, so a
   * series it did not name rendered under the CHARGEABLE prefix while burning its own counter — a
   * document that reads as a garage invoice and is numbered from somewhere else.
   */
  check('  …and a car sale does NOT render under the garage prefix',
    NUM.prefixForSeries('vehicle_sale', profile) === 'VS' && NUM.prefixForSeries('vehicle_sale', profile) !== profile.invoice_prefix,
    'nobody would find that from the number');

  console.log('\n— THE COUNTER IS ITS OWN, AND ROLLS BACK WITH THE TRANSACTION —');
  const before = await prisma.invoiceSequence.findUnique({ where: { group_id: ZZ_GROUP },
    select: { last_value: true, warranty_last_value: true, historical_last_value: true, vehicle_sale_last_value: true } });
  /**
   * EVERY ASSERTION INSIDE ONE TRANSACTION THAT THEN THROWS. It proves three things at once and
   * BURNS NOTHING: a number minted and rolled back must leave no gap, which is the legal guarantee
   * the whole numbering rests on.
   */
  let inside = null;
  await prisma.$transaction(async (tx) => {
    const g = await tx.group.findUnique({ where: { id: ZZ_GROUP }, select: {
      invoice_prefix: true, invoice_warranty_prefix: true, invoice_historical_prefix: true,
      invoice_vehicle_sale_prefix: true, invoice_pad_width: true, invoice_fy_digits: true, fy_start_month: true } });
    const one = await NUM.mintSeriesNumber(tx, ZZ_GROUP, 'vehicle_sale', g, new Date('2026-09-16T10:00:00Z'));
    const two = await NUM.mintSeriesNumber(tx, ZZ_GROUP, 'vehicle_sale', g, new Date('2026-09-16T10:00:00Z'));
    const seq = await tx.invoiceSequence.findUnique({ where: { group_id: ZZ_GROUP },
      select: { last_value: true, warranty_last_value: true, historical_last_value: true, vehicle_sale_last_value: true } });
    inside = { one, two, seq, prefix: g.invoice_vehicle_sale_prefix };
    throw new Error('ROLLBACK_ON_PURPOSE');
  }).catch((e) => { if (!/ROLLBACK_ON_PURPOSE/.test(String(e?.message))) throw e; });

  check('two mints in a row are consecutive', inside && inside.two.sequenceValue === inside.one.sequenceValue + 1,
    `${inside?.one.sequenceValue} then ${inside?.two.sequenceValue}`);
  check('  …and the rendered number carries the vehicle-sale prefix',
    !!inside && inside.one.number.startsWith(inside.prefix), inside?.one.number);
  check('selling a car does NOT advance the garage’s chargeable counter',
    !!inside && inside.seq.last_value === before.last_value,
    `chargeable ${before?.last_value} → ${inside?.seq.last_value} — this is the whole reason the counter is separate`);
  check('  …nor the warranty counter', !!inside && inside.seq.warranty_last_value === before.warranty_last_value);
  check('  …nor the historical counter', !!inside && inside.seq.historical_last_value === before.historical_last_value);
  check('  …while its own counter did move', !!inside && inside.seq.vehicle_sale_last_value === before.vehicle_sale_last_value + 2,
    `${before?.vehicle_sale_last_value} → ${inside?.seq.vehicle_sale_last_value}`);

  const after = await prisma.invoiceSequence.findUnique({ where: { group_id: ZZ_GROUP },
    select: { vehicle_sale_last_value: true } });
  /** NO GAP. A number minted inside a transaction that fails must never have existed. */
  check('a rolled-back mint leaves the counter exactly where it was',
    after.vehicle_sale_last_value === before.vehicle_sale_last_value,
    `${before?.vehicle_sale_last_value} before, ${after?.vehicle_sale_last_value} after — a burned number with no document IS a gap`);

  console.log('\n— WHICH VAT TREATMENT, AND IT TAKES BOTH FACTS —');
  check('a MARGIN car sold is a margin supply', S.vatPositionFor('sold', 'margin') === 'margin');
  check('a QUALIFYING car sold is not', S.vatPositionFor('sold', 'qualifying') === 'qualifying',
    S.vatPositionFor('sold', 'qualifying'));
  check('  …and the same holds for a trade-out', S.vatPositionFor('traded_out', 'qualifying') === 'qualifying');
  check('scrapped is no supply, whatever it was bought as',
    S.vatPositionFor('scrapped', 'margin') === 'none' && S.vatPositionFor('scrapped', 'qualifying') === 'none');
  check('  …and so is returned', S.vatPositionFor('returned', 'qualifying') === 'none');
  check('own use stays UNSETTLED under either scheme',
    S.vatPositionFor('own_use', 'margin') === 'unsettled' && S.vatPositionFor('own_use', 'qualifying') === 'unsettled',
    'a deemed supply whose treatment we cannot state — any figure would be believed');
  /**
   * THE CLAUSE THE FIX EXISTS FOR. Same car, same price, two schemes — and the kind alone cannot
   * tell them apart. Before this, both answered 'margin'.
   */
  check('the scheme CHANGES the answer for an identical sale',
    S.vatPositionFor('sold', 'margin') !== S.vatPositionFor('sold', 'qualifying'),
    'the disposal kind alone used to decide this, and was wrong for every qualifying car');

  console.log('\n— TWO BASES, AND ONLY ONE OF THEM HAS A FLOOR —');
  const marginProfit = S.bookRow({ purchasePence: 500_00, inMarginBasePence: 0, vatStatus: 'margin', disposal: { kind: 'sold', salePence: 800_00 } });
  const qualProfit = S.bookRow({ purchasePence: 500_00, inMarginBasePence: 0, vatStatus: 'qualifying', disposal: { kind: 'sold', salePence: 800_00 } });
  check('a margin car owes a sixth of the MARGIN', marginProfit.vatDuePence === Math.round(300_00 / 6), gbp(marginProfit.vatDuePence));
  check('a qualifying car owes a sixth of the WHOLE PRICE', qualProfit.vatDuePence === Math.round(800_00 / 6), gbp(qualProfit.vatDuePence));
  check('  …so the two differ on the same sale', marginProfit.vatDuePence !== qualProfit.vatDuePence,
    `${gbp(marginProfit.vatDuePence)} vs ${gbp(qualProfit.vatDuePence)} — the old rule gave both the first figure`);

  const marginLoss = S.bookRow({ purchasePence: 800_00, inMarginBasePence: 0, vatStatus: 'margin', disposal: { kind: 'sold', salePence: 500_00 } });
  const qualLoss = S.bookRow({ purchasePence: 800_00, inMarginBasePence: 0, vatStatus: 'qualifying', disposal: { kind: 'sold', salePence: 500_00 } });
  check('a margin car at a loss owes nothing', marginLoss.vatDuePence === 0 && marginLoss.marginPence === -300_00,
    `${gbp(marginLoss.vatDuePence)} on a ${gbp(marginLoss.marginPence)} loss`);
  /**
   * NOT FLOORED. The input tax was reclaimed when the car was bought; a bad sale does not undo that.
   * Flooring this on the margin would be the margin-car arithmetic under another name.
   */
  check('a QUALIFYING car at a loss still owes VAT on the full price',
    qualLoss.vatDuePence === Math.round(500_00 / 6),
    `${gbp(qualLoss.vatDuePence)} on a ${gbp(qualLoss.marginPence)} loss — the floor belongs to the margin scheme alone`);
  check('  …and the book still reports the real loss under both schemes',
    marginLoss.marginPence === -300_00 && qualLoss.marginPence === -300_00);

  /** THE SIGNATURE, not a convention: a caller that forgets the scheme cannot compile. */
  const stockSrc = readFileSync('/Users/hugh/Developer/greasedesk-core/lib/stock.ts', 'utf8');
  const sig = stockSrc.slice(stockSrc.indexOf('export function vatPositionFor'), stockSrc.indexOf(')', stockSrc.indexOf('export function vatPositionFor')));
  // @anchored-ok: a TYPESCRIPT TYPE ANNOTATION, not a data key — `vatStatus: VatStatus` is a parameter and its type, and the clause is about the absent `= default`; hasKey matches the name alone and says nothing about either
  check('vatStatus is a REQUIRED argument, with no default', /vatStatus: VatStatus/.test(sig) && !/vatStatus[^,)]*=/.test(sig),
    'a default would put the wrong answer back silently');
  const bookSig = stockSrc.slice(stockSrc.indexOf('export function bookRow'), stockSrc.indexOf('}): BookRow'));
  // @anchored-ok: the same TYPE ANNOTATION, a required property in bookRow's argument object — the clause is about the `?` NOT being there, a fact about the type rather than about any key's presence
  check('  …and bookRow demands it too', /vatStatus: VatStatus;/.test(bookSig) && !/vatStatus\?/.test(bookSig));
  check('  …while bookRow STILL cannot see costs', !/cost/i.test(bookSig),
    'the scheme was added without opening the door prep costs were kept out of');

  console.log('\n— THE COLUMNS ARE THERE AND HONEST —');
  const cols = await prisma.$queryRaw`
    SELECT table_name, column_name, is_nullable, column_default FROM information_schema.columns
    WHERE (table_name, column_name) IN (('Invoice','vat_position'), ('Group','invoice_vehicle_sale_prefix'), ('InvoiceSequence','vehicle_sale_last_value'))`;
  const col = (t, c) => cols.find((r) => r.table_name === t && r.column_name === c);
  check('Invoice.vat_position exists and is NULLABLE', col('Invoice', 'vat_position')?.is_nullable === 'YES',
    'null on every garage invoice, which is all of them today');
  check('Group.invoice_vehicle_sale_prefix defaults so no tenant is left without one',
    /VS/.test(col('Group', 'invoice_vehicle_sale_prefix')?.column_default ?? ''), col('Group', 'invoice_vehicle_sale_prefix')?.column_default);
  check('InvoiceSequence.vehicle_sale_last_value starts at zero',
    /0/.test(col('InvoiceSequence', 'vehicle_sale_last_value')?.column_default ?? ''), col('InvoiceSequence', 'vehicle_sale_last_value')?.column_default);
  /**
   * WAS "no vehicle_sale invoice exists yet", which was true only because nothing could mint one.
   * Step 2 minted the first, so that clause would now be measuring its own fixtures. The claim that
   * SURVIVES is the one that still matters: the mint has no entry point outside this gate, so no
   * REAL tenant can carry one — and until the code is deployed, a row on a real tenant would meet a
   * production reader that has never heard of the value.
   */
  const strayReal = await prisma.invoice.count({ where: { series: 'vehicle_sale', group_id: { not: ZZ_GROUP } } });
  check('no vehicle_sale invoice exists on any real tenant', strayReal === 0,
    `${strayReal} — there is no UI that mints one, and a deployed reader has not met the value yet`);


  // ════════════════════════════════════════════════════════════════════════════════════════════
  // STEP 2 — THE SALE CARD AND ITS MINT
  // ════════════════════════════════════════════════════════════════════════════════════════════
  const ISS = await import('/Users/hugh/Developer/greasedesk-core/lib/invoice-issue.ts');
  const PREP = await import('/Users/hugh/Developer/greasedesk-core/lib/stock-prep.ts');
  const WIP = await import('/Users/hugh/Developer/greasedesk-core/lib/wip.ts');

  console.log('\n— TWO MARKERS, TWO COLUMNS, AND THE REFUSAL UNTOUCHED —');
  check('a prep card is internal stock and NOT a sale card',
    PREP.isInternalStock({ stock_item_id: 'x' }) === true && PREP.isSaleCard({ stock_item_id: 'x' }) === false);
  check('a sale card is a sale and NOT internal stock',
    PREP.isSaleCard({ sale_of_stock_item_id: 'y' }) === true && PREP.isInternalStock({ sale_of_stock_item_id: 'y' }) === false,
    'one column each — refuseIfInternalStock never hears about sale cards, so it cannot be weakened by reasoning about them');
  check('both at once is a contradiction with words', PREP.isPrepAndSale({ stock_item_id: 'x', sale_of_stock_item_id: 'y' }) === true
    && /different jobs/.test(PREP.SALE_AND_PREP_REFUSAL));
  /**
   * THE REFUSAL IS THE SAME TEXT AS BEFORE THE SALE CARD EXISTED. If a later slice adds an exception
   * to it for sales, this fails — which is the point of the separate column.
   */
  const issSrc = readFileSync('/Users/hugh/Developer/greasedesk-core/lib/invoice-issue.ts', 'utf8');
  const refusal = issSrc.slice(issSrc.indexOf('async function refuseIfInternalStock'), issSrc.indexOf('export async function issueInvoiceForCard'));
  // @anchored-ok: a PRISMA SELECT read out of the function's own source text — `stock_item_id: true` is the select clause being asserted, not a property looked up by name
  const readsOneColumn = /stock_item_id: true/.test(refusal) && !/sale_of_stock_item_id/.test(refusal);
  check('refuseIfInternalStock still reads ONE column and has no exception in it',
    readsOneColumn && !/if \(.*sale/i.test(refusal),
    'a refusal with an exception in it is one exception away from not being a refusal');

  console.log('\n— NEITHER STOCK CARD IS WORK IN PROGRESS —');
  const where = WIP.wipCardsWhere(['site-x']);
  check('the WIP filter excludes prep cards at the QUERY', where.stock_item_id === null,
    'measured on the live tenant before this line: one prep card, £897.13 of £11,244.64 — 8% of "work I am owed for" was the garage’s own car');
  check('  …and sale cards too', where.sale_of_stock_item_id === null);
  check('  …in the ONE place the tile and the list both read', /wipCardsWhere/.test(readFileSync('/Users/hugh/Developer/greasedesk-core/lib/dashboard-tiles.ts', 'utf8'))
    && /wipCardsWhere/.test(readFileSync('/Users/hugh/Developer/greasedesk-core/pages/admin/jobcards/index.tsx', 'utf8')),
    'so the count and the money cannot drift into disagreeing about which cards are open work');

  console.log('\n— THE MINT —');
  const site = await prisma.site.findFirst({ where: { group_id: ZZ_GROUP }, select: { id: true } });
  const user = await prisma.user.findFirst({ where: { group_id: ZZ_GROUP }, select: { id: true } });
  const cust = await prisma.customer.findFirst({ where: { group_id: ZZ_GROUP }, select: { id: true } });
  const mkVeh = (sfx) => prisma.vehicle.create({ data: { group_id: ZZ_GROUP, registration: `${PREFIX}${sfx}`,
    registration_normalized: `${PREFIX}${sfx}`, make: 'ZZ', model: 'Sale' }, select: { id: true } });
  const mkItem = (vehicleId, vat) => prisma.stockItem.create({ data: { group_id: ZZ_GROUP, vehicle_id: vehicleId,
    acquired_at: new Date('2026-02-01'), status: 'advertised', purchase_pence: 500000, vat_status: vat,
    source: 'auction', created_by_user_id: user.id }, select: { id: true } });
  const mkCard = (vehicleId, data) => prisma.jobCard.create({ data: { group_id: ZZ_GROUP, site_id: site.id,
    customer_id: cust?.id ?? null, vehicle_id: vehicleId, status: 'accepted', ...data,
    items: { create: [{ item_type: 'misc', description: 'ZZ vehicle sale', qty: 1, unit_cost: null, unit_price: 8000 }] } }, select: { id: true } });

  // A sold MARGIN car with a sale card.
  const vA = await mkVeh('SALEA'); const itA = await mkItem(vA.id, 'margin');
  await prisma.stockDisposal.create({ data: { group_id: ZZ_GROUP, stock_item_id: itA.id,
    // DATED TODAY: since the sale invoice takes its document date from the disposal, a June disposal would
    // mint a June invoice and put these sales outside the month the ledger clauses below read.
    disposed_at: new Date(), kind: 'sold', sale_pence: 800000, created_by_user_id: user.id } });
  const cardA = await mkCard(vA.id, { sale_of_stock_item_id: itA.id });

  let idA = null, errA = null;
  try {
    idA = await prisma.$transaction((tx) => ISS.issueVehicleSaleInvoice(tx, cardA.id, ZZ_GROUP), { timeout: 20000 });
  } catch (e) { errA = describeError(e); }
  check('a sale card MINTS', !!idA, errA ?? 'minted');
  const invA = idA ? await prisma.invoice.findUnique({ where: { id: idA }, select: { series: true, invoice_number: true, vat_position: true, stock_disposal_id: true, job_card_id: true } }) : null;
  check('  …on the vehicle_sale series, under its own prefix', invA?.series === 'vehicle_sale' && invA?.invoice_number?.startsWith('VS'),
    `${invA?.series} ${invA?.invoice_number}`);
  check('  …carrying the VAT treatment, frozen in the same create', invA?.vat_position === 'margin', String(invA?.vat_position));
  check('  …and naming the disposal it is for', !!invA?.stock_disposal_id);
  check('  …while still hanging on the card, which is the spine every reader follows', invA?.job_card_id === cardA.id);
  const linesA = idA ? await prisma.invoiceLine.count({ where: { invoice_id: idA } }) : 0;
  check('  …with the lines frozen like any other issue', linesA === 1, `${linesA} line(s)`);

  // A QUALIFYING car: same series, different treatment.
  const vQ = await mkVeh('SALEQ'); const itQ = await mkItem(vQ.id, 'qualifying');
  await prisma.stockDisposal.create({ data: { group_id: ZZ_GROUP, stock_item_id: itQ.id,
    disposed_at: new Date(), kind: 'sold', sale_pence: 800000, created_by_user_id: user.id } });
  const cardQ = await mkCard(vQ.id, { sale_of_stock_item_id: itQ.id });
  const idQ = await prisma.$transaction((tx) => ISS.issueVehicleSaleInvoice(tx, cardQ.id, ZZ_GROUP), { timeout: 20000 });
  const invQ = await prisma.invoice.findUnique({ where: { id: idQ }, select: { series: true, vat_position: true } });
  check('a qualifying car mints on the SAME series with a DIFFERENT treatment',
    invQ?.series === invA?.series && invQ?.vat_position === 'qualifying',
    `${invQ?.series}/${invQ?.vat_position} vs ${invA?.series}/${invA?.vat_position} — nothing may infer the tax from the series`);

  console.log('\n— A CAR SALE IS NOT WORKSHOP REVENUE —');
  /**
   * LIVE ONCE THE BUTTON WAS USED, and caught before it was. The workshop ledger took every invoice
   * in the period, so a sale's line — the car at full price, no trade cost — read as an uncosted part
   * and raised gross margin by the whole price. Proved on the two sales minted just above, which are
   * genuinely in this month's window, so the clause can fail.
   */
  const LEDGER = await import('/Users/hugh/Developer/greasedesk-core/lib/charged-labour.ts');
  const SCOPE = await import('/Users/hugh/Developer/greasedesk-core/lib/invoice-series-scope.ts');
  check('the ledger rule states EVERY series, so a fifth cannot arrive by default',
    JSON.stringify(Object.keys(SCOPE.IN_WORKSHOP_LEDGER).sort()) === JSON.stringify([...NUM.INVOICE_SERIES].sort()),
    Object.entries(SCOPE.IN_WORKSHOP_LEDGER).map(([k, v]) => `${k}=${v}`).join(', '));
  const now0 = new Date();
  const monthFrom = new Date(Date.UTC(now0.getUTCFullYear(), now0.getUTCMonth(), 1));
  const monthTo = new Date(Date.UTC(now0.getUTCFullYear(), now0.getUTCMonth() + 1, 1));
  const ledgerSites = (await prisma.site.findMany({ where: { group_id: ZZ_GROUP }, select: { id: true } })).map((x) => x.id);
  const salesInWindow = await prisma.invoice.findMany({
    where: { id: { in: [idA, idQ].filter(Boolean) }, date_issued: { gte: monthFrom, lt: monthTo } },
    select: { id: true, series: true, lines: { select: { item_type: true, qty: true, unit_price: true, unit_cost: true, labour_hours: true, labour_outsourced: true, catalogue_item_id: true } } },
  });
  check('the fixture sales really are in this month’s window', salesInWindow.length === 2, `${salesInWindow.length} of 2`);
  const ledger = await LEDGER.fetchLedgerInvoices({ groupId: ZZ_GROUP, siteIds: ledgerSites, from: monthFrom, to: monthTo });
  check('no car sale reaches the workshop ledger', !ledger.some((i) => i.series === 'vehicle_sale'),
    `${ledger.filter((i) => i.series === 'vehicle_sale').length} vehicle_sale invoice(s) in the ledger read`);
  const rev = LEDGER.labourGrossMargin(ledger);
  const revIfIncluded = LEDGER.labourGrossMargin([...ledger, ...salesInWindow]);
  check('…so the P&L is not raised by the sales — and this is what it would have been',
    revIfIncluded.grossMargin - rev.grossMargin >= 800000 + 666667 - 1,
    `gross margin would have risen by ${gbp(revIfIncluded.grossMargin - rev.grossMargin)} on two cars with no cost of sale`);

  console.log('\n— WHAT IT REFUSES —');
  const refuse = async (label, cardId, re) => {
    let msg = null;
    try { await prisma.$transaction((tx) => ISS.issueVehicleSaleInvoice(tx, cardId, ZZ_GROUP), { timeout: 20000 }); }
    catch (e) { msg = describeError(e); }
    check(label, !!msg && re.test(msg), msg ? msg.replace('IMPORT_ASSERT:', '').slice(0, 110) : 'IT MINTED');
  };
  const vP = await mkVeh('SALEP'); const itP = await mkItem(vP.id, 'margin');
  const cardP = await mkCard(vP.id, { stock_item_id: itP.id });
  /** THE CLAUSE THE SEPARATE COLUMN EXISTS FOR: a PREP card must still be refused, by this route too. */
  await refuse('a PREP card is still refused, on the sale path as well', cardP.id, /nobody to invoice/);
  const vN = await mkVeh('SALEN');
  const cardN = await mkCard(vN.id, {});
  await refuse('  …and an ordinary card cannot raise one', cardN.id, /not selling a car/);
  const vU = await mkVeh('SALEU'); const itU = await mkItem(vU.id, 'margin');
  const cardU = await mkCard(vU.id, { sale_of_stock_item_id: itU.id });
  await refuse('  …nor a car not yet recorded as sold', cardU.id, /not been recorded as sold/);
  const vS = await mkVeh('SALES'); const itS = await mkItem(vS.id, 'margin');
  await prisma.stockDisposal.create({ data: { group_id: ZZ_GROUP, stock_item_id: itS.id,
    disposed_at: new Date('2026-06-03'), kind: 'scrapped', created_by_user_id: user.id } });
  const cardS = await mkCard(vS.id, { sale_of_stock_item_id: itS.id });
  await refuse('  …nor a car that was SCRAPPED, which is not a sale', cardS.id, /not a sale/);

  console.log('\n— billingDivergence RETURNS NULL, AND IT IS LOAD-BEARING —');
  /**
   * TWO INDEPENDENT GUARDS, BOTH INVISIBLE. A sale card has no accepted quote version — a car is not
   * quoted — and the series is not chargeable. Either alone returns null; nothing asserted either,
   * and if the early return went, the mint would compare a live card against a version that does not
   * exist. Both pinned, and pinned SEPARATELY so removing one cannot hide behind the other.
   */
  /**
   * THE SERIES GUARD NEEDS A CARD THAT WOULD OTHERWISE DIVERGE. Tested on a card with no accepted
   * version it cannot fail — the second guard returns null first — and the red-proof caught exactly
   * that: disabling the series line scored 0 failures. So cardA is given an accepted version whose
   * lines differ from its own, and the two guards are then proved on different fixtures.
   */
  const qv = await prisma.quoteVersion.create({ data: {
    group_id: ZZ_GROUP, job_card_id: cardA.id, version: 1, status: 'accepted',
    net_pennies: 500000, vat_pennies: 100000, gross_pennies: 600000, vat_registered: true,
    lines: { create: [{ position: 1, item_type: 'misc', description: 'ZZ agreed something else',
      qty: 1, unit_price: 5000, vat_rate: 20, line_vat: 1000, line_total: 6000 }] },
  }, select: { id: true } });
  const divChargeable = await ISS.billingDivergence(prisma, cardA.id, { series: 'chargeable' });
  check('the fixture really diverges, so the guard below has something to stop',
    divChargeable !== null, divChargeable ? `agreed ${gbp(divChargeable.agreedPennies)} vs live ${gbp(divChargeable.livePennies)}` : 'IT DID NOT DIVERGE');
  const divSeries = await ISS.billingDivergence(prisma, cardA.id, { series: 'vehicle_sale' });
  check('  …and a vehicle_sale series is still not expected to track a card', divSeries === null, String(divSeries));

  /** THE SECOND GUARD, on a card with no quote version at all — which is every real sale card. */
  const acceptedQ = await prisma.quoteVersion.count({ where: { job_card_id: cardQ.id, status: 'accepted' } });
  check('a real sale card has no accepted quote version at all', acceptedQ === 0, `${acceptedQ}`);
  const divNoQuote = await ISS.billingDivergence(prisma, cardQ.id, { series: 'chargeable' });
  check('  …and with none, it is null even when called as chargeable', divNoQuote === null,
    'a car is never quoted, so this is the guard that actually carries a sale card — independently of the series');
  await prisma.quoteVersionLine.deleteMany({ where: { quote_version_id: qv.id } });
  await prisma.quoteVersion.delete({ where: { id: qv.id } });

  console.log('\n— AND IT IS OUT OF THE WORK FIGURES —');
  const zzSites = await prisma.site.findMany({ where: { group_id: ZZ_GROUP }, select: { id: true } });
  const wipIds = (await prisma.jobCard.findMany({ where: WIP.wipCardsWhere(zzSites.map((x) => x.id)), select: { id: true } })).map((c) => c.id);
  /**
   * WRITTEN WRONG FIRST TIME, and it would have passed while sale cards leaked: the condition read
   * `!includes(cardN) === false || !includes(cardU)`, which is satisfied by the ORDINARY card being
   * in WIP and says nothing about either sale card. Asserted directly now, on both sale cards —
   * cardU is accepted and unbilled, so it is in WIP by every rule except this one.
   */
  check('no sale card is counted as open work',
    !wipIds.includes(cardU.id) && !wipIds.includes(cardA.id) && !wipIds.includes(cardQ.id),
    `${wipIds.length} WIP card(s) on ZZ; sale cards present: ${[cardU.id, cardA.id, cardQ.id].filter((i) => wipIds.includes(i)).length}`);
  check('  …and neither is the prep card', !wipIds.includes(cardP.id));
  check('  …while an ordinary unbilled card still is', wipIds.includes(cardN.id),
    'the exclusion must be about stock, not about everything');

  // ════════════════════════════════════════════════════════════════════════════════════════════
  // STEP 3 — MARGIN PRESENTATION, ACROSS THE THREE RENDERERS
  // ════════════════════════════════════════════════════════════════════════════════════════════
  const MS = await import('/Users/hugh/Developer/greasedesk-core/lib/margin-scheme.ts');

  console.log('\n— WHAT A DOCUMENT MAY SAY ABOUT VAT —');
  check('a margin sale suppresses the breakdown', MS.vatPresentation({ vatRegistered: true, vatPosition: 'margin' }) === 'margin_scheme');
  check('a QUALIFYING sale is an ordinary VAT invoice', MS.vatPresentation({ vatRegistered: true, vatPosition: 'qualifying' }) === 'normal',
    'both are vehicle_sale — the series cannot tell them apart, so the presentation must not read it');
  check('a garage invoice is unchanged', MS.vatPresentation({ vatRegistered: true, vatPosition: null }) === 'normal',
    'null on every invoice that is not a car sale, which is all of them today');
  /**
   * THE ORDER OF THE TWO TESTS IS LOAD-BEARING. A garage that is not VAT registered cannot be on the
   * margin scheme, so a margin statement on its document would claim a registration it does not
   * have — and vat_position can still read 'margin', because the stock book's arithmetic is about
   * the car, not about the garage.
   */
  check('an UNREGISTERED garage never claims the margin scheme',
    MS.vatPresentation({ vatRegistered: false, vatPosition: 'margin' }) === 'not_registered',
    'the car may be a margin car; the garage is not registered, and the document must not say it is');
  check('  …and shows no VAT and no statement either way',
    !MS.showsVatBreakdown('not_registered') && !MS.showsMarginStatement('not_registered'));
  check('only the margin presentation carries the statement',
    MS.showsMarginStatement('margin_scheme') && !MS.showsMarginStatement('normal'));

  /**
   * THE FIGURE, AND THE TRAP. An unregistered garage's net IS its price. A margin document suppresses
   * VAT that genuinely exists INSIDE the price, so its single total must be the GROSS — showing the
   * net would under-state the car by a sixth of its margin and the document would not reconcile
   * against the payment.
   */
  const tot = { netPennies: 666_667, grossPennies: 800_000 };
  check('a margin total is the GROSS — the money handed over', MS.singleTotalPennies('margin_scheme', tot) === 800_000,
    gbp(MS.singleTotalPennies('margin_scheme', tot)));
  check('  …while an unregistered garage shows its net, which IS its price',
    MS.singleTotalPennies('not_registered', tot) === 666_667, gbp(MS.singleTotalPennies('not_registered', tot)));
  check('  …so the two single-total modes are NOT interchangeable',
    MS.singleTotalPennies('margin_scheme', tot) !== MS.singleTotalPennies('not_registered', tot),
    `${gbp(MS.singleTotalPennies('margin_scheme', tot))} vs ${gbp(MS.singleTotalPennies('not_registered', tot))} — a sixth of the margin`);

  console.log('\n— ONE RULE, AND ALL THREE RENDERERS READ IT —');
  /**
   * ENUMERATED FROM THE FILES, NOT FROM A NAMING CONVENTION. The three renderers each build their own
   * markup — React DOM, react-pdf primitives, and the shared table — so the rule is the only thing
   * they can share. A renderer added later that skips it is the failure this is for.
   */
  const RENDERERS = {
    'the admin invoice page': 'pages/admin/invoices/[id].tsx',
    'the PDF the customer keeps': 'lib/invoice-pdf.tsx',
    'the document behind their link': 'components/DocumentLines.tsx',
  };
  /**
   * COMMENTS STRIPPED FIRST. Every one of these files SAYS "lib/margin-scheme" in a comment pointing
   * at the rule — so a raw scan is satisfied by the note explaining the import and passes with the
   * import gone. Red-proved: deleting the PDF's import scored 0 failures until this was added.
   */
  const code = (f) => readFileSync(`/Users/hugh/Developer/greasedesk-core/${f}`, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  for (const [name, f] of Object.entries(RENDERERS)) {
    const c = code(f);
    // BOTH, not either. `||` let a file that USES the symbols without importing them pass — which is
    // broken code the compiler would reject, but a clause that cannot fail is not a clause.
    check(`${name} reads the shared rule, in CODE and not in a comment`,
      /from '@\/lib\/margin-scheme'/.test(c) && /vatPresentation|singleTotalPennies|MARGIN_SCHEME_STATEMENT/.test(c), f);
    // NARROWED 2026-09-16 to the lines that DECIDE the presentation. The whole-file version was satisfied only
    // while nothing else on the page named the series — and the car-sale date lock legitimately does. What must
    // never happen is the VAT decision reading the series; that is what is asserted.
    const deciding = c.split('\n').filter((l) => /vatPresentation\(|margin_scheme/.test(l));
    check(`  …and decides nothing about VAT from the series itself`,
      deciding.length > 0 && !deciding.some((l) => /\bseries\b/.test(l)),
      `${deciding.length} deciding line(s) — a margin car and a qualifying one are both vehicle_sale`);
  }
  /**
   * THE VAT COLUMN GOES WITH THE TOTALS. A row reading "20%" beside a margin total is the same false
   * statement in a smaller font — and nothing asserted it: the red-proof setting showVatCols back to
   * showVat scored 0 failures.
   */
  const dl = code('components/DocumentLines.tsx');
  check('the shared table derives its VAT COLUMN from the presentation, not from showVat alone',
    /showVatCols\s*=\s*showVat\s*&&\s*vatPresentation\s*!==\s*'margin_scheme'/.test(dl)
      && !/\{showVat &&/.test(dl),
    'a 20% column beside a margin total says the same untrue thing as the line it replaced');
  const msSrc = readFileSync('/Users/hugh/Developer/greasedesk-core/lib/margin-scheme.ts', 'utf8');
  check('the statement has exactly one home', (msSrc.match(/Margin scheme — second-hand goods/g) ?? []).length === 1
    && Object.values(RENDERERS).every((f) => !/Margin scheme/.test(readFileSync(`/Users/hugh/Developer/greasedesk-core/${f}`, 'utf8'))),
    'a compliance sentence copied into three files is three sentences to change on an accountant’s advice');

  console.log('\n— ON A REAL MINTED DOCUMENT —');
  const DOC = await import('/Users/hugh/Developer/greasedesk-core/lib/invoice-doc.ts');
  const docA = await DOC.buildInvoiceDoc(idA, ZZ_GROUP).catch((e) => ({ error: describeError(e) }));
  check('the built document carries the treatment through', docA?.vatPosition === 'margin',
    String(docA?.vatPosition ?? docA?.error));
  check('  …and the shared rule turns it into a margin presentation',
    MS.vatPresentation({ vatRegistered: !!docA?.vatRegistered, vatPosition: docA?.vatPosition ?? null }) === 'margin_scheme',
    `registered=${docA?.vatRegistered}`);
  const docQ = await DOC.buildInvoiceDoc(idQ, ZZ_GROUP).catch(() => null);
  check('  …while the qualifying car’s document stays an ordinary VAT invoice',
    MS.vatPresentation({ vatRegistered: !!docQ?.vatRegistered, vatPosition: docQ?.vatPosition ?? null }) === 'normal',
    `vatPosition=${docQ?.vatPosition}`);
  /** THE TOTAL A CUSTOMER SEES, on the real figures rather than a fixture. */
  check('  …and the margin document’s single total is its gross',
    !!docA && MS.singleTotalPennies('margin_scheme', docA.totals) === docA.totals.grossPennies
      && docA.totals.grossPennies > 0,
    gbp(docA?.totals?.grossPennies ?? 0));

  console.log('\n— AND ON THE PAGE A PERSON ACTUALLY OPENS —');
  /**
   * A SOURCE SCAN IS NOT A RENDER. Everything above proves the rule and the wiring; this proves the
   * document. Last, deliberately: a browser leg that throws ends the run, and every clause above is
   * cheaper than this one.
   */
  const ready = await serverReady();
  check('the dev server serves pages before we drive it', ready.ok, `HTTP ${ready.status}`);
  const origin = gateOrigin();
  browser = await chromium.launch({ channel: 'chrome' });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 1000 } });
  const page = await ctx.newPage();
  await page.goto(`${origin}/admin/login`, { waitUntil: 'domcontentloaded' });
  await page.fill('input[type="email"]', 'owner@zzgategarage.test');
  await page.fill('input[type="password"]', 'GateGarage!2026');
  await Promise.all([page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 60000 }), page.click('button[type="submit"]')]);

  const readDoc = async (invoiceId) => {
    await page.goto(`${origin}/admin/invoices/${invoiceId}`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('[data-testid="vat-rate-line"], [data-testid="margin-scheme-statement"]', { timeout: 25000 }).catch(() => {});
    return page.evaluate(() => ({
      rateLines: document.querySelectorAll('[data-testid="vat-rate-line"]').length,
      totalLine: document.querySelectorAll('[data-testid="vat-total-line"]').length,
      statement: document.querySelector('[data-testid="margin-scheme-statement"]')?.textContent ?? null,
      marginTotal: document.querySelector('[data-testid="margin-total"]')?.textContent ?? null,
      body: document.body.innerText,
    }));
  };
  const shownA = await readDoc(idA);
  check('the margin sale shows NO VAT line anywhere on the page',
    shownA.rateLines === 0 && shownA.totalLine === 0,
    `${shownA.rateLines} rate line(s), ${shownA.totalLine} total line(s)`);
  check('  …carries the margin-scheme statement', shownA.statement === MS.MARGIN_SCHEME_STATEMENT,
    (shownA.statement ?? 'ABSENT').slice(0, 90));
  check('  …and its one figure is the gross the customer paid',
    !!shownA.marginTotal && shownA.marginTotal.replace(/[^0-9.]/g, '') === (docA.totals.grossPennies / 100).toFixed(2),
    `${shownA.marginTotal} against ${gbp(docA.totals.grossPennies)}`);
  /** THE DISCRIMINATOR: the same page, the same series, a different scheme. */
  const shownQ = await readDoc(idQ);
  check('a QUALIFYING sale on the same series still shows its VAT',
    shownQ.rateLines >= 1 && shownQ.statement === null,
    `${shownQ.rateLines} rate line(s), statement ${shownQ.statement === null ? 'absent' : 'PRESENT'} — the presentation follows the treatment, not the series`);

} catch (e) {
  check('run completed', false, describeError(e).slice(0, 300));
} finally {
  await browser?.close().catch(() => {});
  if (prisma) {
    try {
      const vs = await prisma.vehicle.findMany({ where: { group_id: ZZ_GROUP, registration: { startsWith: PREFIX } }, select: { id: true } });
      const ids = vs.map((v) => v.id);
      if (ids.length) {
        const cards = await prisma.jobCard.findMany({ where: { vehicle_id: { in: ids } }, select: { id: true } });
        const cids = cards.map((c) => c.id);
        const qvs = await prisma.quoteVersion.findMany({ where: { job_card_id: { in: cids } }, select: { id: true } });
        await prisma.quoteVersionLine.deleteMany({ where: { quote_version_id: { in: qvs.map((q) => q.id) } } });
        await prisma.quoteVersion.deleteMany({ where: { id: { in: qvs.map((q) => q.id) } } });
        const invs = await prisma.invoice.findMany({ where: { job_card_id: { in: cids } }, select: { id: true } });
        await prisma.invoiceLine.deleteMany({ where: { invoice_id: { in: invs.map((i) => i.id) } } });
        await prisma.invoice.deleteMany({ where: { id: { in: invs.map((i) => i.id) } } });
        await prisma.jobCardItem.deleteMany({ where: { job_card_id: { in: cids } } });
        await prisma.jobCard.deleteMany({ where: { id: { in: cids } } });
        const its = await prisma.stockItem.findMany({ where: { vehicle_id: { in: ids } }, select: { id: true } });
        await prisma.stockDisposal.deleteMany({ where: { stock_item_id: { in: its.map((i) => i.id) } } });
        await prisma.stockItem.deleteMany({ where: { id: { in: its.map((i) => i.id) } } });
        await prisma.vehicle.deleteMany({ where: { id: { in: ids } } });
      }
      const left = await prisma.vehicle.count({ where: { group_id: ZZ_GROUP, registration: { startsWith: PREFIX } } });
      check('teardown left ZZ with none of this gate’s cars', left === 0, `${ids.length} removed, ${left} left`);
    } catch (e) { check('teardown completed', false, describeError(e).slice(0, 200)); }
  }
}
console.log(`\n${out.filter((c) => c === 'F').length} failures of ${out.length}`);
await prisma?.$disconnect();
process.exit(out.includes('F') ? 1 : 0);
