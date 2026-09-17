/**
 * File: scripts/historical-sale-gate.mjs
 * @gate-requires: db
 *
 * A CAR SOLD BEFORE CAR SALES WERE INVOICED HERE — recorded, not invoiced.
 *
 * ── WHAT THIS IS FOR ────────────────────────────────────────────────────────────────────────────
 * The owner sold cars from April with receipts, before GreaseDesk could invoice a car sale. The sold
 * dashboard and the stock book need them; the VAT screen must not. So a past sale is a RECORD: stock
 * item, costs, buyer, and a disposal MARKED recorded-not-invoiced — and nothing minted. The clauses
 * this gate exists for:
 *  · the BOUNDARY is a date — the first car sale invoiced here — and there is none until one exists
 *  · NOTHING is minted: no invoice, no sale card, no counter but the stock number
 *  · a blank is never silent — filled, or ticked "not on the paperwork", never both, never neither
 *  · "not supplied" (looked, not there) reads differently from "not recorded" (nobody asked)
 *  · ownership is ADDED, never rewritten; a later owner refuses and is SHOWN
 *  · every car gets a stock number, from one counter, spent only by a row that exists
 *  · one writer of the marker, enumerated from the source
 *
 * FIXTURES ON ZZ ONLY, prefix ZZHS, swept before and after. Audit rows are left, per the standing rule.
 * Every expected money figure is worked BY HAND in the clause, never read back through the code under test.
 */
import './_gate-preflight.mjs';
const { gatePrisma, describeError, ZZ_GROUP } = await import('./_gate-preflight.mjs');
import './_ts.mjs';
const { readFileSync, readdirSync, statSync } = await import('node:fs');

const out = [];
const check = (n, ok, d = '') => { out.push(ok ? 'P' : 'F'); console.log(`${ok ? '✓' : '✗'} ${n}${d ? `  — ${d}` : ''}`); };
const PREFIX = 'ZZHS';
const R = '/Users/hugh/Developer/greasedesk-core';

const PW = await import(`${R}/lib/stock-paperwork.ts`);
const AM = await import(`${R}/lib/anchored-match.ts`);
const HR = await import(`${R}/lib/stock-historical-rules.ts`);

let prisma;
try {
  // ════════════════════════════════════════════════════════════════════════════════════════════
  // PURE — cheapest first
  // ════════════════════════════════════════════════════════════════════════════════════════════
  console.log('— A FIELD HAS THREE STATES, NOT TWO —');
  const rec = PW.paperworkField('Joe Bloggs', 'seller_name', []);
  const sup = PW.paperworkField(null, 'seller_name', ['seller_name']);
  const nr = PW.paperworkField(null, 'seller_name', []);
  check('a value is recorded', rec.state === 'recorded' && PW.paperworkText(rec) === 'Joe Bloggs');
  check('a tick with no value reads NOT SUPPLIED — somebody looked and it was not there',
    sup.state === 'not_supplied' && PW.paperworkText(sup) === 'not supplied', PW.paperworkText(sup));
  check('no value and no tick reads NOT RECORDED — nobody was asked', nr.state === 'not_recorded' && PW.paperworkText(nr) === 'not recorded');
  check('  …and the two absences print DIFFERENT words', PW.paperworkText(sup) !== PW.paperworkText(nr));
  check('  …a whitespace value is not a value', PW.paperworkField('   ', 'seller_name', []).state === 'not_recorded');
  check('  …a tick for ANOTHER field does not make this one supplied', PW.paperworkField(null, 'seller_name', ['purchase_ref']).state === 'not_recorded');

  console.log('\n— A BLANK IS NEVER SILENT —');
  const KP = PW.PURCHASE_PAPERWORK_KEYS;
  const full = { seller_name: 'A Seller', purchase_ref: 'P-1', mileage: 81234, make_model: 'MINI Cooper' };
  check('everything filled passes', PW.checkPaperwork(KP, full, []) === null);
  check('everything ticked passes — "I looked and none of it was there" is an answer', PW.checkPaperwork(KP, {}, [...KP]) === null);
  const blank = PW.checkPaperwork(KP, { ...full, purchase_ref: '' }, []) ?? '';
  check('a blank, unticked field refuses and NAMES the field', /^Purchase invoice or receipt number is blank/.test(blank), blank.slice(0, 70));
  check('  …and says what to do: fill it or tick it', /tick “not on the paperwork”/.test(blank));
  const both = PW.checkPaperwork(KP, full, ['seller_name']) ?? '';
  check('filled AND ticked refuses — one of the two is wrong', /^Seller is filled in AND ticked/.test(both), both.slice(0, 60));
  check('a tick for a field this form does not have refuses', !!PW.checkPaperwork(KP, full, ['receipt_ref']));
  check('an unreadable tick list refuses rather than counting as none', !!PW.checkPaperwork(KP, full, 'seller_name'));
  check('mileage 0 is a value, not a blank', PW.checkPaperwork(['mileage'], { mileage: 0 }, []) === null);

  console.log('\n— THE BOUNDARY IS A DATE —');
  const b = { date: new Date('2026-09-17T10:00:00Z'), invoiceNumber: 'VS-0001' };
  check('the day before the first invoiced sale is history', HR.boundaryRefusal(new Date('2026-09-16T23:30:00Z'), b) === null);
  const same = HR.boundaryRefusal(new Date('2026-09-17T00:05:00Z'), b) ?? '';
  check('the SAME day refuses — "on or after"', /on or after 17 Sep 2026/.test(same), same.slice(0, 80));
  check('  …and names the invoice that set the boundary, and where the sale goes instead', /VS-0001/.test(same) && /Sell this car/.test(same));
  check('the day after refuses', !!HR.boundaryRefusal(new Date('2026-09-18T12:00:00Z'), b));
  check('with no invoiced sale yet, the refusal says why and when that changes',
    /once your first car sale has been invoiced/.test(HR.HISTORICAL_NO_BOUNDARY_REFUSAL));

  console.log('\n— THE CHEAP REFUSALS —');
  const ok = { registration: 'AB12CDE', acquiredAt: new Date('2026-01-01'), soldAt: new Date('2026-02-01'), purchasePence: 100000, salePence: 200000, vatStatus: 'margin', source: 'private', now: new Date('2026-09-17') };
  check('a sound entry passes', HR.historicalBasicsRefusal(ok) === null, HR.historicalBasicsRefusal(ok) ?? '');
  check('sold before bought refuses', !!HR.historicalBasicsRefusal({ ...ok, soldAt: new Date('2025-12-31') }));
  check('a sale in the future refuses', !!HR.historicalBasicsRefusal({ ...ok, soldAt: new Date('2026-09-18'), acquiredAt: new Date('2026-09-01') }));
  check('a return refuses — its earlier sale would be invented', HR.historicalBasicsRefusal({ ...ok, source: 'return' }) === HR.HISTORICAL_REACQUISITION_REFUSAL);
  check('  …and so does a buyback', HR.historicalBasicsRefusal({ ...ok, source: 'buyback' }) === HR.HISTORICAL_REACQUISITION_REFUSAL);
  check('no scheme refuses', !!HR.historicalBasicsRefusal({ ...ok, vatStatus: '' }));
  check('a zero sale price refuses', !!HR.historicalBasicsRefusal({ ...ok, salePence: 0 }));

  console.log('\n— OWNERSHIP IS ADDED, NEVER REWRITTEN —');
  const bought = new Date('2026-03-01T12:00:00Z');
  const e = (from, to, cur) => ({ customerName: 'K', validFrom: new Date(from), validTo: to ? new Date(to) : null, isCurrent: cur });
  check('a keeper whose record ENDED before we bought it is the car’s past, not a conflict',
    HR.ownershipConflicts([e('2020-01-01', '2026-02-10', false)], bought).length === 0);
  check('  …nor one ending ON the purchase day — that is who we bought it from',
    HR.ownershipConflicts([e('2020-01-01', '2026-03-01T09:00:00Z', false)], bought).length === 0);
  check('a CURRENT owner conflicts', HR.ownershipConflicts([e('2020-01-01', null, true)], bought).length === 1);
  check('an owner whose record reaches past the purchase conflicts', HR.ownershipConflicts([e('2020-01-01', '2026-04-01', false)], bought).length === 1);
  const orf = HR.ownershipRefusal([{ customerName: 'Jane Owner', validFrom: new Date('2026-05-02'), validTo: null, isCurrent: true }]);
  check('the refusal SHOWS what is there: who, from when, still current', /Jane Owner, from 2 May 2026 and still current/.test(orf), orf.slice(0, 110));
  check('  …and says it never rewrites', /never rewrites ownership/.test(orf));
  check('held periods: a car still in stock overlaps anything', !!HR.overlapsHeld([{ acquiredAt: new Date('2025-01-01'), disposedAt: null }], new Date('2026-01-01'), new Date('2026-02-01')));
  check('  …an earlier, finished holding does not', HR.overlapsHeld([{ acquiredAt: new Date('2025-01-01'), disposedAt: new Date('2025-06-01') }], new Date('2026-01-01'), new Date('2026-02-01')) === null);

  // ════════════════════════════════════════════════════════════════════════════════════════════
  // THE ONE WRITER OF THE MARKER — enumerated from the source, and the scan proved on a planted case
  // ════════════════════════════════════════════════════════════════════════════════════════════
  console.log('\n— ONE WRITER OF recorded_not_invoiced —');
  const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  // Read as BYTES and decoded, never grepped: one NUL byte makes grep print nothing for a whole file.
  // Anchored through lib/anchored-match: `notInvoiced?:` in a type is a declaration, and hasKey does not
  // take the `?` form as a key — so the declaration in lib/stock-store is not counted as a caller.
  //
  // A READ IS NOT A WRITE. `select: { recorded_not_invoiced: true }` carries the same key and value as a
  // write, and the first version of this scan counted lib/vat-summary's select as a writer (the tier run
  // went RED on it). So each occurrence is judged by the object it sits in: inside `select:` or `where:`
  // it reads; anywhere else it writes.
  const enclosingKey = (src, idx) => {
    let depth = 0;
    for (let i = idx; i >= 0; i -= 1) {
      if (src[i] === '}') depth += 1;
      else if (src[i] === '{') {
        if (depth === 0) return (src.slice(Math.max(0, i - 40), i).match(/(\w+)\s*:\s*$/) ?? [])[1] ?? null;
        depth -= 1;
      }
    }
    return null;
  };
  const writesMarker = (raw) => {
    const src = strip(raw);
    if (AM.hasKey(src, 'notInvoiced')) return true;
    return [...src.matchAll(AM.keyRegex('recorded_not_invoiced', 'true', 'g'))]
      .some((m) => !['select', 'where'].includes(enclosingKey(src, m.index)));
  };
  check('the scan finds a planted writer', writesMarker("await recordDisposalInTx(tx, { kind: 'sold', notInvoiced: { receiptRef: null } })"));
  check('  …and a planted direct write', writesMarker("await tx.stockDisposal.create({ data: { kind: 'sold', recorded_not_invoiced: true } })"));
  check('  …but not a READ of the same key', !writesMarker("await prisma.stockDisposal.findMany({ select: { id: true, recorded_not_invoiced: true } })")
    && !writesMarker("await prisma.stockDisposal.count({ where: { recorded_not_invoiced: true } })"));
  check('  …and ignores one in a comment', !writesMarker('// notInvoiced: { receiptRef: null }'));
  const files = [];
  const walk = (d) => { for (const f of readdirSync(`${R}/${d}`)) { const p = `${d}/${f}`; if (statSync(`${R}/${p}`).isDirectory()) walk(p); else if (/\.(ts|tsx)$/.test(f)) files.push(p); } };
  ['lib', 'pages', 'components'].forEach(walk);
  const writers = files.filter((f) => writesMarker(readFileSync(`${R}/${f}`).toString('utf8')));
  // lib/stock-store DECLARES the parameter and spreads it; lib/stock-historical is the only caller passing it.
  check('only lib/stock-historical passes the marker, and lib/stock-store is the only place that stores it',
    JSON.stringify(writers.sort()) === JSON.stringify(['lib/stock-historical.ts', 'lib/stock-store.ts']),
    `${files.length} files scanned: ${writers.join(', ')}`);
  const storeSrc = strip(readFileSync(`${R}/lib/stock-store.ts`, 'utf8'));
  check('  …and the store sets it ONLY from that parameter, never unconditionally',
    AM.countKey(storeSrc, 'recorded_not_invoiced', 'true') === 1
      && /\.\.\.\(a\.notInvoiced \? \{\s*recorded_not_invoiced: true/.test(storeSrc));

  // ════════════════════════════════════════════════════════════════════════════════════════════
  // THROUGH THE REAL WRITER, ON ZZ
  // ════════════════════════════════════════════════════════════════════════════════════════════
  prisma = await gatePrisma();
  const ST = await import(`${R}/lib/stock-store.ts`);
  const SALE = await import(`${R}/lib/stock-sale.ts`);
  const HS = await import(`${R}/lib/stock-historical.ts`);

  const sweep = async () => {
    const vs = await prisma.vehicle.findMany({ where: { group_id: ZZ_GROUP, registration: { startsWith: PREFIX } }, select: { id: true, identity_id: true } });
    const ids = vs.map((v) => v.id);
    if (ids.length) {
      const cards = (await prisma.jobCard.findMany({ where: { vehicle_id: { in: ids } }, select: { id: true } })).map((c) => c.id);
      const invs = (await prisma.invoice.findMany({ where: { job_card_id: { in: cards } }, select: { id: true } })).map((i) => i.id);
      await prisma.invoiceLine.deleteMany({ where: { invoice_id: { in: invs } } });
      await prisma.invoice.deleteMany({ where: { id: { in: invs } } });
      await prisma.jobCardItem.deleteMany({ where: { job_card_id: { in: cards } } });
      await prisma.jobCard.deleteMany({ where: { id: { in: cards } } });
      const its = (await prisma.stockItem.findMany({ where: { vehicle_id: { in: ids } }, select: { id: true } })).map((i) => i.id);
      await prisma.stockCostSnapshot.deleteMany({ where: { stock_item_id: { in: its } } });
      await prisma.stockCost.deleteMany({ where: { stock_item_id: { in: its } } });
      await prisma.stockDisposal.deleteMany({ where: { stock_item_id: { in: its } } });
      await prisma.stockItem.deleteMany({ where: { id: { in: its } } });
      await prisma.vehicle.deleteMany({ where: { id: { in: ids } } });
      const idents = vs.map((v) => v.identity_id).filter(Boolean);
      if (idents.length) await prisma.vehicleIdentity.deleteMany({ where: { id: { in: idents }, vehicles: { none: {} } } });
    }
    await prisma.customer.deleteMany({ where: { group_id: ZZ_GROUP, name: { startsWith: PREFIX }, ownerships: { none: {} }, job_cards: { none: {} } } });
    return ids.length;
  };
  const swept = await sweep();
  if (swept) console.log(`\n  (swept ${swept} fixture car(s) left by an earlier run)`);

  const site = await prisma.site.findFirst({ where: { group_id: ZZ_GROUP }, select: { id: true } });
  const user = await prisma.user.findFirst({ where: { group_id: ZZ_GROUP }, select: { id: true } });
  const counters = async () => {
    const s = await prisma.invoiceSequence.findUnique({ where: { group_id: ZZ_GROUP }, select: { last_value: true, vehicle_sale_last_value: true, historical_last_value: true, warranty_last_value: true } });
    const k = await prisma.stockNumberSequence.findUnique({ where: { group_id: ZZ_GROUP }, select: { last_value: true } });
    return { chargeable: s?.last_value ?? 0, vs: s?.vehicle_sale_last_value ?? 0, historical: s?.historical_last_value ?? 0, warranty: s?.warranty_last_value ?? 0, stock: k?.last_value ?? 0 };
  };
  const regCount = (reg) => prisma.vehicle.count({ where: { group_id: ZZ_GROUP, registration: reg } });
  const NONE = '00000000-0000-0000-0000-000000000000';
  const got = (r) => (r && 'stockItemId' in r ? r : { stockItemId: NONE, disposalId: NONE, stockNumber: -1, customerId: NONE });

  const entry = (over = {}) => ({
    groupId: ZZ_GROUP, userId: user.id, siteId: site.id,
    registration: `${PREFIX}10M`, make: 'MINI', model: 'Cooper',
    acquiredAt: new Date('2026-01-10T00:00:00Z'), soldAt: new Date('2026-02-20T00:00:00Z'),
    purchasePence: 150000, salePence: 260000, vatStatus: 'margin', source: 'private',
    sellerName: 'Private seller, Dudley', purchaseRef: 'P-7781', mileageMiles: 81234,
    buyer: { name: `${PREFIX} Past Buyer`, address: '4 Past Lane\nWalsall' },
    receiptRef: 'R-0042',
    notOnPaperwork: { purchase: [], sale: [] },
    costs: [
      { kind: 'valeting', description: 'Full valet', amountPence: 12000, incurredOn: new Date('2026-01-15T00:00:00Z'), vatTreatment: 'standard_recoverable' },
      { kind: 'mot', description: 'MOT', amountPence: 5400, incurredOn: new Date('2026-01-20T00:00:00Z'), vatTreatment: 'no_vat' },
    ],
    ...over,
  });

  console.log('\n— NO BOUNDARY, NO ENTRY —');
  const vsOnZz = await prisma.invoice.count({ where: { group_id: ZZ_GROUP, series: 'vehicle_sale' } });
  check('premise: ZZ holds no car-sale invoice at the start', vsOnZz === 0,
    `${vsOnZz} found — a previous run left one, and every boundary clause below would read ITS date`);
  const early = await HS.recordHistoricalSale(entry());
  check('with no car sale invoiced yet, a past sale refuses', 'refused' in early && early.refused === HR.HISTORICAL_NO_BOUNDARY_REFUSAL,
    'refused' in early ? early.refused.slice(0, 70) : 'IT RECORDED A SALE WITH NO BOUNDARY');
  check('  …and wrote nothing, not even the car', (await regCount(`${PREFIX}10M`)) === 0);

  console.log('\n— THE FIRST INVOICED SALE SETS THE BOUNDARY —');
  const bv = await prisma.vehicle.create({ data: { group_id: ZZ_GROUP, registration: `${PREFIX}01B`, registration_normalized: `${PREFIX}01B`, make: 'MINI', model: 'One' }, select: { id: true } });
  const bItem = await ST.takeIntoStock({ groupId: ZZ_GROUP, userId: user.id, vehicleId: bv.id, acquiredAt: new Date('2026-02-01T00:00:00Z'), purchasePence: 300000, vatStatus: 'margin', source: 'trade' });
  if ('refused' in bItem) throw new Error(bItem.refused);
  const boundaryDay = new Date('2026-03-12T00:00:00Z');
  const bSale = await SALE.sellCar({ groupId: ZZ_GROUP, userId: user.id, siteId: site.id, stockItemId: bItem.id, soldAt: boundaryDay,
    salePence: 450000, buyer: { name: `${PREFIX} Live Buyer`, address: '1 Live Road\nTipton' } });
  check('the live sale completes', 'invoiceId' in bSale, 'refused' in bSale ? bSale.refused : 'sold');
  const bInv = 'invoiceId' in bSale ? await prisma.invoice.findUnique({ where: { id: bSale.invoiceId }, select: { invoice_number: true } }) : null;
  const boundary = await HS.historicalBoundary(ZZ_GROUP);
  check('the boundary is THAT sale’s date and number', boundary?.date.toISOString() === boundaryDay.toISOString() && boundary?.invoiceNumber === bInv?.invoice_number,
    `${boundary?.date?.toISOString?.()} ${boundary?.invoiceNumber}`);
  const bDisp = await prisma.stockDisposal.findFirst({ where: { stock_item_id: bItem.id }, select: { buyer_name: true, buyer_address: true, recorded_not_invoiced: true, receipt_ref: true } });
  check('a LIVE sale freezes its buyer onto the disposal for the book', bDisp?.buyer_name === `${PREFIX} Live Buyer` && /Tipton/.test(bDisp?.buyer_address ?? ''),
    `${bDisp?.buyer_name} / ${bDisp?.buyer_address}`);
  check('  …and is NOT marked recorded-not-invoiced, and carries no receipt number — its invoice is the record',
    bDisp?.recorded_not_invoiced === false && bDisp?.receipt_ref === null);

  const onDay = await HS.recordHistoricalSale(entry({ registration: `${PREFIX}11M`, acquiredAt: new Date('2026-03-01T00:00:00Z'), soldAt: new Date('2026-03-12T15:00:00Z') }));
  check('a past sale ON the boundary day refuses', 'refused' in onDay && /on or after 12 Mar 2026/.test(onDay.refused), 'refused' in onDay ? onDay.refused.slice(0, 80) : 'ACCEPTED');
  const after = await HS.recordHistoricalSale(entry({ registration: `${PREFIX}12M`, acquiredAt: new Date('2026-03-01T00:00:00Z'), soldAt: new Date('2026-04-02T00:00:00Z') }));
  check('  …and after it', 'refused' in after);
  check('  …and neither wrote a car', (await regCount(`${PREFIX}11M`)) + (await regCount(`${PREFIX}12M`)) === 0);

  console.log('\n— A PAST SALE, RECORDED: NOTHING MINTED —');
  const c0 = await counters();
  const h = await HS.recordHistoricalSale(entry());
  check('the entry completes', 'stockItemId' in h, 'refused' in h ? h.refused : 'recorded');
  const H = got(h);
  const c1 = await counters();
  check('it took the NEXT stock number, and the counter says so', H.stockNumber === c0.stock + 1 && c1.stock === c0.stock + 1,
    `number ${H.stockNumber}, counter ${c0.stock} → ${c1.stock}`);
  check('NO invoice counter moved — car sale, chargeable, historical, warranty',
    c1.vs === c0.vs && c1.chargeable === c0.chargeable && c1.historical === c0.historical && c1.warranty === c0.warranty,
    JSON.stringify({ before: c0, after: c1 }));
  check('no invoice names this disposal', (await prisma.invoice.count({ where: { stock_disposal_id: H.disposalId } })) === 0);
  check('no sale card names this car', (await prisma.jobCard.count({ where: { sale_of_stock_item_id: H.stockItemId } })) === 0);
  const hItem = await prisma.stockItem.findUnique({ where: { id: H.stockItemId }, select: { stock_number: true, seller_name: true, purchase_ref: true, not_on_paperwork: true, acquired_at: true, purchase_pence: true, vat_status: true } });
  check('the stock item carries its number, seller and purchase reference', hItem?.stock_number === H.stockNumber && hItem?.seller_name === 'Private seller, Dudley' && hItem?.purchase_ref === 'P-7781',
    JSON.stringify(hItem));
  const hDisp = await prisma.stockDisposal.findUnique({ where: { id: H.disposalId }, select: { kind: true, sale_pence: true, disposed_at: true, recorded_not_invoiced: true, receipt_ref: true, buyer_name: true, buyer_address: true, buyer_customer_id: true, not_on_paperwork: true } });
  check('THE MARKER: recorded, not invoiced, with the receipt number', hDisp?.recorded_not_invoiced === true && hDisp?.receipt_ref === 'R-0042', JSON.stringify(hDisp));
  check('  …sold, at the price, on the date', hDisp?.kind === 'sold' && hDisp?.sale_pence === 260000 && hDisp?.disposed_at.toISOString() === '2026-02-20T00:00:00.000Z');
  check('  …with the buyer as they were', hDisp?.buyer_name === `${PREFIX} Past Buyer` && /Walsall/.test(hDisp?.buyer_address ?? '') && hDisp?.buyer_customer_id === H.customerId);
  const snaps = await prisma.stockCostSnapshot.findMany({ where: { stock_item_id: H.stockItemId }, select: { amount_pence: true } });
  const frozenTotal = snaps.reduce((t, s) => t + s.amount_pence, 0);
  // £120 standard-rated holds £20 of VAT ZZ reclaims → £100; the £54 MOT carried no VAT → £54.
  check('the bills froze through the SAME freeze a live sale uses: £100 + £54', frozenTotal === 15400, `${frozenTotal}p over ${snaps.length} row(s)`);
  const buyer = await prisma.customer.findUnique({ where: { id: H.customerId }, select: { name: true, address: true } });
  check('the buyer is a real customer', buyer?.name === `${PREFIX} Past Buyer`);
  const veh = await prisma.vehicle.findFirst({ where: { group_id: ZZ_GROUP, registration: `${PREFIX}10M` }, select: { id: true } });
  const edges = await prisma.vehicleOwnership.findMany({ where: { vehicle_id: veh?.id ?? NONE }, select: { customer_id: true, is_current: true, valid_from: true } });
  check('  …and owns the car from the sale date — its MOT is a lead', edges.length === 1 && edges[0].customer_id === H.customerId && edges[0].is_current && edges[0].valid_from.toISOString() === '2026-02-20T00:00:00.000Z',
    `${edges.length} edge(s)`);
  const odo = await prisma.vehicleOdometerReading.findFirst({ where: { vehicle_id: veh?.id ?? NONE }, select: { miles: true } });
  check('the mileage went into the car’s reading series', odo?.miles === 81234, `${odo?.miles}`);
  const audit = await prisma.auditLog.findFirst({ where: { group_id: ZZ_GROUP, action: 'stock.recorded_historical', entity_id: H.stockItemId }, select: { entity: true } });
  check('an audit row says what was recorded', audit?.entity === 'stock_item');
  const sold = await ST.soldInPeriod(ZZ_GROUP, new Date('2026-02-01T00:00:00Z'), new Date('2026-02-28T23:59:59Z'));
  const row = sold.rows.find((r) => r.stockItemId === H.stockItemId);
  // £2,600 − £1,500 − £154 = £946.
  check('THE SOLD DASHBOARD HAS IT: £2,600 less £1,500 less £154 of costs', !!row && row.salePence - row.purchasePence - row.costsPence === 94600,
    row ? `${row.salePence - row.purchasePence - row.costsPence}p` : 'NOT IN THE PERIOD');
  const book = await ST.stockBook(ZZ_GROUP, new Date('2026-02-01T00:00:00Z'), new Date('2026-02-28T23:59:59Z'));
  check('THE STOCK BOOK HAS IT, as a disposal', book.disposals.some((d) => d.stockItemId === H.stockItemId));

  console.log('\n— “NOT ON THE PAPERWORK” IS STORED AS A FACT —');
  const t = await HS.recordHistoricalSale(entry({
    registration: `${PREFIX}20M`, sellerName: '', purchaseRef: null, buyer: null, receiptRef: '',
    notOnPaperwork: { purchase: ['seller_name', 'purchase_ref'], sale: ['buyer_name', 'buyer_address', 'receipt_ref'] }, costs: [],
  }));
  check('an entry with the seller, the reference and the buyer all ticked completes', 'stockItemId' in t, 'refused' in t ? t.refused : 'recorded');
  const T = got(t);
  const tItem = await prisma.stockItem.findUnique({ where: { id: T.stockItemId }, select: { seller_name: true, not_on_paperwork: true } });
  const tDisp = await prisma.stockDisposal.findUnique({ where: { id: T.disposalId }, select: { not_on_paperwork: true, buyer_name: true, receipt_ref: true, recorded_not_invoiced: true } });
  check('the purchase ticks are STORED on the car', JSON.stringify(tItem?.not_on_paperwork) === '["seller_name","purchase_ref"]', JSON.stringify(tItem?.not_on_paperwork));
  check('the sale ticks are STORED on the disposal', JSON.stringify(tDisp?.not_on_paperwork) === '["buyer_name","buyer_address","receipt_ref"]', JSON.stringify(tDisp?.not_on_paperwork));
  check('  …and read back as NOT SUPPLIED', PW.paperworkField(tItem?.seller_name, 'seller_name', tItem?.not_on_paperwork).state === 'not_supplied'
    && PW.paperworkField(tDisp?.receipt_ref, 'receipt_ref', tDisp?.not_on_paperwork).state === 'not_supplied');
  check('no buyer on the paperwork: no customer made, no owner added', T.customerId === null
    && (await prisma.vehicleOwnership.count({ where: { vehicle: { registration: `${PREFIX}20M`, group_id: ZZ_GROUP } } })) === 0);
  check('  …and still marked recorded-not-invoiced', tDisp?.recorded_not_invoiced === true);

  const nv = await prisma.vehicle.create({ data: { group_id: ZZ_GROUP, registration: `${PREFIX}21L`, registration_normalized: `${PREFIX}21L` }, select: { id: true } });
  const live = await ST.takeIntoStock({ groupId: ZZ_GROUP, userId: user.id, vehicleId: nv.id, acquiredAt: new Date('2026-06-27T00:00:00Z'), purchasePence: 50000, vatStatus: 'margin', source: 'private' });
  const liveItem = 'id' in live ? await prisma.stockItem.findUnique({ where: { id: live.id }, select: { seller_name: true, not_on_paperwork: true, stock_number: true } }) : null;
  check('a car taken in through NORMAL intake reads NOT RECORDED, not "not supplied" — nobody asked',
    PW.paperworkField(liveItem?.seller_name, 'seller_name', liveItem?.not_on_paperwork).state === 'not_recorded', 'the LC09XFU case');
  check('  …but it DOES get a stock number — every car', Number.isInteger(liveItem?.stock_number) && liveItem.stock_number > 0, `${liveItem?.stock_number}`);
  if ('id' in live) {
    const livePrep = await ST.addStockCost({ groupId: ZZ_GROUP, userId: user.id, stockItemId: live.id, kind: 'prep_parts',
      description: 'Brake pads', amountPence: 4800, incurredOn: new Date('2026-06-28T00:00:00Z'), vatTreatment: 'standard_recoverable' });
    check('PREP PARTS on a car in stock refuse, and say why — its card already counts them',
      'refused' in livePrep && /count the same part twice/.test(livePrep.refused), 'refused' in livePrep ? livePrep.refused.slice(0, 80) : 'ACCEPTED — a doubled part');
    const liveRepair = await ST.addStockCost({ groupId: ZZ_GROUP, userId: user.id, stockItemId: live.id, kind: 'bought_in_repairs',
      description: 'Smart repair, rear bumper', amountPence: 9000, incurredOn: new Date('2026-06-28T00:00:00Z'), vatTreatment: 'standard_recoverable' });
    check('  …while BOUGHT-IN REPAIRS are accepted on any car', 'id' in liveRepair, 'refused' in liveRepair ? liveRepair.refused : '');
    check('  …and only the repair was written', JSON.stringify((await prisma.stockCost.findMany({ where: { stock_item_id: live.id }, select: { kind: true } })).map((r) => r.kind)) === '["bought_in_repairs"]');
  }
  const cBefore = (await counters()).stock;
  const twice = await ST.takeIntoStock({ groupId: ZZ_GROUP, userId: user.id, vehicleId: nv.id, acquiredAt: new Date('2026-06-28T00:00:00Z'), purchasePence: 50000, vatStatus: 'margin', source: 'private' });
  check('a REFUSED intake spends no stock number', 'refused' in twice && (await counters()).stock === cBefore, `${cBefore} → ${(await counters()).stock}`);

  console.log('\n— A PAST SALE CARRIES ITS PREP AS BILLS —');
  const pp = await HS.recordHistoricalSale(entry({
    registration: `${PREFIX}25M`,
    costs: [
      { kind: 'prep_parts', description: 'Clutch kit, GSF invoice 88213', amountPence: 21600, incurredOn: new Date('2026-01-12T00:00:00Z'), vatTreatment: 'standard_recoverable' },
      { kind: 'prep_parts', description: 'Parts from a private seller', amountPence: 3000, incurredOn: new Date('2026-01-13T00:00:00Z'), vatTreatment: 'no_vat' },
      { kind: 'bought_in_repairs', description: 'Alloy refurb, VAT not reclaimed', amountPence: 18000, incurredOn: new Date('2026-01-14T00:00:00Z'), vatTreatment: 'standard_not_recoverable' },
    ],
  }));
  check('prep parts and bought-in repairs are accepted on a past sale', 'stockItemId' in pp, 'refused' in pp ? pp.refused : '');
  const PP = got(pp);
  const ppSnaps = await prisma.stockCostSnapshot.findMany({ where: { stock_item_id: PP.stockItemId }, select: { kind: true, amount_pence: true } });
  // £216 reclaimed → £180; £30 no VAT → £30; £180 whose VAT was NOT reclaimed → £180. Total £390.
  check('each bill froze at what it cost the car: £180 + £30 + £180, the VAT choice per bill deciding it',
    ppSnaps.reduce((t, r) => t + r.amount_pence, 0) === 39000 && ppSnaps.length === 3,
    ppSnaps.map((r) => `${r.kind} ${r.amount_pence}`).join(', '));
  check('  …keeping their kinds, so the book can say which were parts', ppSnaps.filter((r) => r.kind === 'prep_parts').length === 2);
  const badKind = await HS.recordHistoricalSale(entry({ registration: `${PREFIX}26M`, costs: [{ kind: 'advertising', description: 'AutoTrader', amountPence: 5000, incurredOn: new Date('2026-01-12T00:00:00Z'), vatTreatment: 'no_vat' }] }));
  check('a kind that is not a direct cost refuses on a past sale too, naming the row', 'refused' in badKind && /^Cost 1:/.test(badKind.refused));
  const lateBill = await HS.recordHistoricalSale(entry({ registration: `${PREFIX}27M`, costs: [{ kind: 'prep_parts', description: 'Late part', amountPence: 5000, incurredOn: new Date('2026-03-01T00:00:00Z'), vatTreatment: 'no_vat' }] }));
  check('a bill dated after the sale refuses', 'refused' in lateBill && /after the car was sold/.test(lateBill.refused));

  console.log('\n— A BLANK REFUSES, AND WRITES NOTHING —');
  const bl = await HS.recordHistoricalSale(entry({ registration: `${PREFIX}30M`, sellerName: '' }));
  check('a blank seller with no tick refuses, naming it', 'refused' in bl && /^Seller is blank/.test(bl.refused), 'refused' in bl ? bl.refused.slice(0, 50) : 'ACCEPTED');
  const bt = await HS.recordHistoricalSale(entry({ registration: `${PREFIX}31M`, notOnPaperwork: { purchase: ['seller_name'], sale: [] } }));
  check('a filled seller that is ALSO ticked refuses', 'refused' in bt && /filled in AND ticked/.test(bt.refused));
  const noBuyerTick = await HS.recordHistoricalSale(entry({ registration: `${PREFIX}32M`, buyer: null }));
  check('no buyer and no tick refuses, naming the buyer', 'refused' in noBuyerTick && /^Buyer is blank/.test(noBuyerTick.refused), 'refused' in noBuyerTick ? noBuyerTick.refused.slice(0, 40) : 'ACCEPTED');
  check('  …and none of the three wrote a car', (await regCount(`${PREFIX}30M`)) + (await regCount(`${PREFIX}31M`)) + (await regCount(`${PREFIX}32M`)) === 0);

  console.log('\n— OWNERSHIP IS NEVER REWRITTEN —');
  const ov = await prisma.vehicle.create({ data: { group_id: ZZ_GROUP, registration: `${PREFIX}40M`, registration_normalized: `${PREFIX}40M`, make: 'MINI', model: 'Cooper' }, select: { id: true } });
  const later = await prisma.customer.create({ data: { group_id: ZZ_GROUP, site_id: site.id, name: `${PREFIX} Brought It Back`, address: '9 Service Road' }, select: { id: true } });
  await prisma.vehicleOwnership.create({ data: { vehicle_id: ov.id, customer_id: later.id, is_current: true, valid_from: new Date('2026-05-02T00:00:00Z') } });
  /**
   * A THROW MUST STAY A FAILED CLAUSE. With the writer's owner check removed, this entry died on the
   * database's one-current-owner rule and ended the run at 79 of 86 — red, but not on the clause that
   * names the defect. So these calls turn a throw into a refusal-shaped result the clauses can read.
   */
  const attempt = async (input) => { try { return await HS.recordHistoricalSale(input); } catch (x) { return { threw: describeError(x).slice(0, 120) }; } };
  const oc = await attempt(entry({ registration: `${PREFIX}40M` }));
  check('a car GreaseDesk already records with a later owner refuses', 'refused' in oc && /never rewrites ownership/.test(oc.refused), 'refused' in oc ? oc.refused.slice(0, 60) : 'ACCEPTED');
  check('  …and SHOWS who, from when', 'refused' in oc && oc.refused.includes(`${PREFIX} Brought It Back, from 2 May 2026 and still current`), 'refused' in oc ? oc.refused : '');
  const ovEdges = await prisma.vehicleOwnership.findMany({ where: { vehicle_id: ov.id }, select: { customer_id: true, is_current: true, valid_to: true } });
  check('  …and left that owner exactly as it was, and no stock item', ovEdges.length === 1 && ovEdges[0].is_current && ovEdges[0].valid_to === null
    && (await prisma.stockItem.count({ where: { vehicle_id: ov.id } })) === 0);

  /**
   * THE CASE THE DATABASE CANNOT CATCH. A current owner collides with the partial unique index on its own,
   * so it proves nothing about this writer. An owner whose record has ENDED but reaches past our purchase
   * is not current — only the writer's rule refuses it.
   */
  const ev = await prisma.vehicle.create({ data: { group_id: ZZ_GROUP, registration: `${PREFIX}42M`, registration_normalized: `${PREFIX}42M`, make: 'MINI', model: 'Cooper' }, select: { id: true } });
  const overlap = await prisma.customer.create({ data: { group_id: ZZ_GROUP, site_id: site.id, name: `${PREFIX} Had It Later`, address: '3 Later Road' }, select: { id: true } });
  await prisma.vehicleOwnership.create({ data: { vehicle_id: ev.id, customer_id: overlap.id, is_current: false, valid_from: new Date('2025-06-01T00:00:00Z'), valid_to: new Date('2026-06-01T00:00:00Z') } });
  const ec = await attempt(entry({ registration: `${PREFIX}42M` }));
  check('an ENDED owner whose record reaches past the purchase refuses too — no database rule catches this one',
    'refused' in ec && ec.refused.includes(`${PREFIX} Had It Later, from 1 Jun 2025 to 1 Jun 2026`),
    'refused' in ec ? ec.refused.slice(0, 100) : ('threw' in ec ? `THREW ${ec.threw}` : 'ACCEPTED — a second owner was written over the same months'));
  check('  …and added no owner', (await prisma.vehicleOwnership.count({ where: { vehicle_id: ev.id } })) === 1);

  const pv = await prisma.vehicle.create({ data: { group_id: ZZ_GROUP, registration: `${PREFIX}41M`, registration_normalized: `${PREFIX}41M`, make: 'MINI', model: 'Cooper' }, select: { id: true } });
  const prior = await prisma.customer.create({ data: { group_id: ZZ_GROUP, site_id: site.id, name: `${PREFIX} Sold It To Us`, address: '2 Seller Road' }, select: { id: true } });
  await prisma.vehicleOwnership.create({ data: { vehicle_id: pv.id, customer_id: prior.id, is_current: false, valid_from: new Date('2019-01-01T00:00:00Z'), valid_to: new Date('2026-01-09T00:00:00Z') } });
  const pc = await HS.recordHistoricalSale(entry({ registration: `${PREFIX}41M` }));
  check('a keeper whose record ended BEFORE we bought it does not block', 'stockItemId' in pc, 'refused' in pc ? pc.refused.slice(0, 80) : 'recorded');
  const pvPrior = await prisma.vehicleOwnership.findFirst({ where: { vehicle_id: pv.id, customer_id: prior.id }, select: { valid_to: true, is_current: true } });
  check('  …and that past record is untouched', pvPrior?.valid_to?.toISOString() === '2026-01-09T00:00:00.000Z' && pvPrior?.is_current === false);

  console.log('\n— A PICKED BUYER —');
  const known = await prisma.customer.create({ data: { group_id: ZZ_GROUP, site_id: site.id, name: `${PREFIX} On The Books`, address: '7 Known Street' }, select: { id: true } });
  const custBefore = await prisma.customer.count({ where: { group_id: ZZ_GROUP } });
  const pk = await HS.recordHistoricalSale(entry({ registration: `${PREFIX}50M`, buyer: { customerId: known.id } }));
  check('a customer already on the books is used, not copied', 'stockItemId' in pk && pk.customerId === known.id
    && (await prisma.customer.count({ where: { group_id: ZZ_GROUP } })) === custBefore, 'refused' in pk ? pk.refused : '');
  const noAddr = await prisma.customer.create({ data: { group_id: ZZ_GROUP, site_id: site.id, name: `${PREFIX} No Address` }, select: { id: true } });
  const na = await HS.recordHistoricalSale(entry({ registration: `${PREFIX}51M`, buyer: { customerId: noAddr.id } }));
  check('a picked customer with no address refuses unless the address is ticked', 'refused' in na && /no address on file/.test(na.refused));
  const naT = await HS.recordHistoricalSale(entry({ registration: `${PREFIX}52M`, buyer: { customerId: noAddr.id }, notOnPaperwork: { purchase: [], sale: ['buyer_address'] } }));
  check('  …and completes when it is', 'stockItemId' in naT, 'refused' in naT ? naT.refused : '');
} catch (err) {
  check('run completed', false, describeError(err).slice(0, 300));
} finally {
  if (prisma) {
    try {
      const vs = await prisma.vehicle.findMany({ where: { group_id: ZZ_GROUP, registration: { startsWith: PREFIX } }, select: { id: true, identity_id: true } });
      const ids = vs.map((v) => v.id);
      if (ids.length) {
        const cards = (await prisma.jobCard.findMany({ where: { vehicle_id: { in: ids } }, select: { id: true } })).map((c) => c.id);
        const invs = (await prisma.invoice.findMany({ where: { job_card_id: { in: cards } }, select: { id: true } })).map((i) => i.id);
        await prisma.invoiceLine.deleteMany({ where: { invoice_id: { in: invs } } });
        await prisma.invoice.deleteMany({ where: { id: { in: invs } } });
        await prisma.jobCardItem.deleteMany({ where: { job_card_id: { in: cards } } });
        await prisma.jobCard.deleteMany({ where: { id: { in: cards } } });
        const its = (await prisma.stockItem.findMany({ where: { vehicle_id: { in: ids } }, select: { id: true } })).map((i) => i.id);
        await prisma.stockCostSnapshot.deleteMany({ where: { stock_item_id: { in: its } } });
        await prisma.stockCost.deleteMany({ where: { stock_item_id: { in: its } } });
        await prisma.stockDisposal.deleteMany({ where: { stock_item_id: { in: its } } });
        await prisma.stockItem.deleteMany({ where: { id: { in: its } } });
        await prisma.vehicle.deleteMany({ where: { id: { in: ids } } });
        const idents = vs.map((v) => v.identity_id).filter(Boolean);
        if (idents.length) await prisma.vehicleIdentity.deleteMany({ where: { id: { in: idents }, vehicles: { none: {} } } });
      }
      await prisma.customer.deleteMany({ where: { group_id: ZZ_GROUP, name: { startsWith: PREFIX }, ownerships: { none: {} }, job_cards: { none: {} } } });
      const leftV = await prisma.vehicle.count({ where: { group_id: ZZ_GROUP, registration: { startsWith: PREFIX } } });
      const leftC = await prisma.customer.count({ where: { group_id: ZZ_GROUP, name: { startsWith: PREFIX } } });
      const leftVs = await prisma.invoice.count({ where: { group_id: ZZ_GROUP, series: 'vehicle_sale' } });
      check('teardown left ZZ with none of this gate’s cars, customers or car-sale invoices', leftV === 0 && leftC === 0 && leftVs === 0,
        `${ids.length} car(s) removed; ${leftV} car(s), ${leftC} customer(s), ${leftVs} car-sale invoice(s) left`);
    } catch (e2) { check('teardown completed', false, describeError(e2).slice(0, 200)); }
  }
}
console.log(`\n${out.filter((c) => c === 'F').length} failures of ${out.length}`);
await prisma?.$disconnect();
process.exit(out.includes('F') ? 1 : 0);
