/**
 * File: scripts/car-sale-gate.mjs
 * @gate-requires: db, server
 *
 * SELL A CAR — four writes, one transaction, and the doors around it.
 *
 * ── WHAT THIS IS FOR ────────────────────────────────────────────────────────────────────────────
 * Before this, nothing in the app could record a sale at all: /api/stock had a `dispose` action and
 * no screen called it. A sale is ONE fact in four parts — the disposal, ownership moving to the buyer,
 * the sale card, the invoice — and the clause this gate exists for is the failure one: a mint that
 * throws after everything else has been written must leave NOTHING behind. No disposal, no owner
 * change, no card, no customer, no counter moved.
 *
 * ── AND THE DOORS ───────────────────────────────────────────────────────────────────────────────
 *  · `dispose` with kind sold refuses — reachable but uncalled is how a half-state arrives later
 *  · traded_out refuses everywhere until part-exchange defines it
 *  · ownership is ENDED and OPENED — ensureIdentityAndCurrentOwner only writes an owner when there
 *    is none, so on a sold car it would have kept the previous one
 *  · an open prep card WARNS in words and never blocks
 *
 * FIXTURES ON ZZ ONLY, prefix ZZCS, swept before and after. Audit rows are left, per the standing rule.
 */
import './_gate-preflight.mjs';
const { gatePrisma, describeError, ZZ_GROUP, gateOrigin, serverReady } = await import('./_gate-preflight.mjs');
import './_ts.mjs';
const { chromium } = await import('/Users/hugh/Developer/greasedesk-core/node_modules/playwright-core/index.mjs');
const { readFileSync } = await import('node:fs');
const { urlUnder } = await import('/Users/hugh/Developer/greasedesk-core/lib/anchored-match.ts');

const out = [];
const check = (n, ok, d = '') => { out.push(ok ? 'P' : 'F'); console.log(`${ok ? '✓' : '✗'} ${n}${d ? `  — ${d}` : ''}`); };
const PREFIX = 'ZZCS';
const R = '/Users/hugh/Developer/greasedesk-core';
const code = (f) => readFileSync(`${R}/${f}`, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, '').replace(/^\s*\/\/.*$/gm, '');

const RULES = await import(`${R}/lib/stock-sale-rules.ts`);

let prisma;
let browser = null;
try {
  // ════════════════════════════════════════════════════════════════════════════════════════════
  // PURE — cheapest first
  // ════════════════════════════════════════════════════════════════════════════════════════════
  console.log('— WHAT A BUYER NEEDS —');
  check('no buyer refuses', !!RULES.buyerRefusal(null));
  check('a name with no address refuses, and says why the address cannot wait',
    /cannot be changed to add it later/.test(RULES.buyerRefusal({ name: 'A Buyer', address: ' ' }) ?? ''),
    RULES.buyerRefusal({ name: 'A Buyer', address: '' }) ?? 'ACCEPTED');
  check('  …name and address together is enough', RULES.buyerRefusal({ name: 'A Buyer', address: '1 Road' }) === null);
  check('  …and so is a customer picked from the books', RULES.buyerRefusal({ customerId: 'x' }) === null);

  console.log('\n— THE PREP WARNING NAMES THE CONSEQUENCE AND THE REMEDY —');
  const w1 = RULES.openPrepWarning('WT16GMV', [{ id: 'c1', status: 'accepted' }]) ?? '';
  check('no open card, no warning', RULES.openPrepWarning('WT16GMV', []) === null);
  check('it names the car', w1.startsWith('WT16GMV has an open prep card.'), w1.slice(0, 60));
  check('  …says the costs freeze NOW', /Selling freezes its costs now/.test(w1));
  check('  …says what that costs: late parts do not reach the book', /will not reach the book/.test(w1));
  check('  …and says what to do: close the card if the work is done', /close the card first/.test(w1));
  check('  …or accept that late parts land outside the car’s cost', /outside this car’s cost/.test(w1),
    'not a generic are-you-sure — those are read as furniture');
  check('  …and counts when there is more than one', /2 open prep cards/.test(RULES.openPrepWarning('X1', [{ id: 'a', status: 'accepted' }, { id: 'b', status: 'draft' }]) ?? ''));
  /** WRITTEN AS THE CLOSED SET, so a status nobody listed errs towards the warning, never silence. */
  check('an unknown status counts as OPEN', RULES.isOpenPrepStatus('some_future_status') === true);
  check('  …while done and cancelled are closed', !RULES.isOpenPrepStatus('done') && !RULES.isOpenPrepStatus('cancelled'));

  console.log('\n— THE SALE LINE IS BUILT FOR THE SCHEME —');
  const lm = RULES.saleLine(800000, 'margin');
  check('a margin car: the whole price at 0%', lm.unitPricePounds === '8000.00' && lm.vatRate === 0 && lm.vatAmountPounds === '0.00',
    JSON.stringify(lm));
  const lq = RULES.saleLine(800000, 'qualifying');
  check('a qualifying car: a sixth of the gross as VAT at 20%', lq.vatRate === 20 && lq.vatAmountPounds === '1333.33', JSON.stringify(lq));
  check('  …worked from the gross DOWN, so the total is the price to the penny',
    Math.round(Number(lq.unitPricePounds) * 100) + Math.round(Number(lq.vatAmountPounds) * 100) === 800000,
    `${lq.unitPricePounds} + ${lq.vatAmountPounds}`);
  check('the line names the car the way its V5C will', RULES.saleLineDescription({ registration: 'AB12CDE', make: 'MINI', model: 'Cooper', year: 2012 }) === 'Sale of 2012 MINI Cooper, registration AB12CDE');

  console.log('\n— NO KIND TO CHOOSE, AND NO traded_out —');
  const saleSrc = code('lib/stock-sale.ts');
  const sig = saleSrc.slice(saleSrc.indexOf('export async function sellCar('), saleSrc.indexOf('}, deps: SaleDeps'));
  check('sellCar takes no disposal kind at all', !/\bkind\b/.test(sig), 'the sale path offers nothing else');
  // @anchored-ok: one literal argument read out of sellCar's own source — the fixed disposal kind it passes, not a property looked up by name
  check('  …and writes kind sold, fixed', /kind: 'sold'/.test(saleSrc));
  const panel = code('components/stock/SellCarPanel.tsx');
  check('the sale panel offers no traded_out and no kind picker', !/traded_out/.test(panel) && !/\bkind\b/.test(panel),
    'a label with no definition gets chosen');

  // ════════════════════════════════════════════════════════════════════════════════════════════
  // DATABASE
  // ════════════════════════════════════════════════════════════════════════════════════════════
  prisma = await gatePrisma();
  const ST = await import(`${R}/lib/stock-store.ts`);
  const SALE = await import(`${R}/lib/stock-sale.ts`);
  const CC = await import(`${R}/lib/customer-car.ts`);
  const WIP = await import(`${R}/lib/wip.ts`);

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
      await prisma.stockDisposal.deleteMany({ where: { stock_item_id: { in: its } } });
      await prisma.stockItem.deleteMany({ where: { id: { in: its } } });
      await prisma.vehicle.deleteMany({ where: { id: { in: ids } } });
      const idents = vs.map((v) => v.identity_id).filter(Boolean);
      if (idents.length) await prisma.vehicleIdentity.deleteMany({ where: { id: { in: idents }, vehicles: { none: {} } } });
    }
    await prisma.customer.deleteMany({ where: { group_id: ZZ_GROUP, name: { startsWith: PREFIX }, ownerships: { none: {} }, job_cards: { none: {} } } });
    return ids.length;
  };
  const before = await sweep();
  if (before) console.log(`\n  (swept ${before} fixture car(s) left by an earlier run)`);

  const site = await prisma.site.findFirst({ where: { group_id: ZZ_GROUP }, select: { id: true } });
  const user = await prisma.user.findFirst({ where: { group_id: ZZ_GROUP }, select: { id: true } });
  let n = 0;
  const car = async (vat = 'margin') => {
    n += 1;
    const reg = `${PREFIX}${String(n).padStart(2, '0')}${vat === 'qualifying' ? 'Q' : 'M'}`;
    const v = await prisma.vehicle.create({ data: { group_id: ZZ_GROUP, registration: reg, registration_normalized: reg, make: 'MINI', model: 'Cooper', year: 2012 }, select: { id: true } });
    const it = await prisma.stockItem.create({ data: { group_id: ZZ_GROUP, vehicle_id: v.id, acquired_at: new Date('2026-03-01'),
      status: 'advertised', purchase_pence: 500000, vat_status: vat, source: 'auction', created_by_user_id: user.id }, select: { id: true } });
    return { reg, vehicleId: v.id, itemId: it.id };
  };
  const mkCustomer = (sfx, address) => prisma.customer.create({ data: { group_id: ZZ_GROUP, site_id: site.id, name: `${PREFIX} ${sfx}`, address }, select: { id: true } });
  const soldAt = new Date('2026-09-12T00:00:00.000Z');
  /**
   * A FAILED SALE MUST STAY A FAILED CLAUSE, NOT BECOME A THROW. The first red-proofs ended this gate
   * at 32 of 72: once a sale refused, the next clause read `sa.customerId`, and worse,
   * `findFirst({ where: { id: undefined } })` returns SOME row rather than none. Every id read from a
   * result goes through this, so a missing one matches nothing and the clauses below still run.
   */
  const NONE = '00000000-0000-0000-0000-000000000000';
  const ids = (r) => ('invoiceId' in (r ?? {}) ? r : { invoiceId: NONE, cardId: NONE, disposalId: NONE, customerId: NONE });

  console.log('\n— THE API DOOR IS CLOSED —');
  const door = await car();
  const viaDispose = await ST.recordDisposal({ groupId: ZZ_GROUP, userId: user.id, stockItemId: door.itemId, disposedAt: soldAt, kind: 'sold', salePence: 700000 });
  check('recording a SALE as a bare disposal refuses', 'refused' in viaDispose && viaDispose.refused === RULES.SALE_PATH_REFUSAL,
    ('refused' in viaDispose ? viaDispose.refused : 'IT RECORDED A SOLD CAR WITH NO INVOICE').slice(0, 100));
  check('  …and points at the sale path', /Sell this car/.test(RULES.SALE_PATH_REFUSAL));
  check('  …and wrote nothing', (await prisma.stockDisposal.count({ where: { stock_item_id: door.itemId } })) === 0);
  const viaTraded = await ST.recordDisposal({ groupId: ZZ_GROUP, userId: user.id, stockItemId: door.itemId, disposedAt: soldAt, kind: 'traded_out', salePence: 700000 });
  check('traded_out refuses too, until part-exchange defines it', 'refused' in viaTraded && /not usable yet/.test(viaTraded.refused));
  const viaScrap = await ST.recordDisposal({ groupId: ZZ_GROUP, userId: user.id, stockItemId: door.itemId, disposedAt: soldAt, kind: 'scrapped' });
  check('  …while a car that is NOT sold can still leave that way', 'id' in viaScrap, 'refused' in viaScrap ? viaScrap.refused : 'scrapped');

  console.log('\n— A SALE TO A NEW BUYER: ALL FOUR PARTS —');
  const a = await car('margin');
  const prev = await mkCustomer('Previous keeper', '9 Old Street');
  await prisma.vehicleOwnership.create({ data: { vehicle_id: a.vehicleId, customer_id: prev.id, is_current: true } });
  const counterBefore = (await prisma.invoiceSequence.findUnique({ where: { group_id: ZZ_GROUP }, select: { vehicle_sale_last_value: true } }))?.vehicle_sale_last_value ?? 0;
  const sa = await SALE.sellCar({ groupId: ZZ_GROUP, userId: user.id, siteId: site.id, stockItemId: a.itemId, soldAt,
    salePence: 800000, buyer: { name: `${PREFIX} New Buyer`, address: '1 Buyer Road\nBirmingham', phone: '07700 900123', email: 'zz-buyer@example.invalid' } });
  check('the sale completes', 'invoiceId' in sa, 'refused' in sa ? sa.refused : 'sold');
  const A = ids(sa);
  const disp = await prisma.stockDisposal.findFirst({ where: { stock_item_id: a.itemId }, select: { id: true, kind: true, sale_pence: true, disposed_at: true } });
  check('1 · the disposal: sold, at the price, on the date', disp?.kind === 'sold' && disp.sale_pence === 800000 && disp.disposed_at.toISOString() === soldAt.toISOString(),
    `${disp?.kind} ${disp?.sale_pence} ${disp?.disposed_at?.toISOString?.()}`);
  const buyer = await prisma.customer.findFirst({ where: { id: A.customerId }, select: { name: true, address: true, phone_e164: true } });
  check('2 · the buyer is a real customer, with the address the invoice needs', buyer?.name === `${PREFIX} New Buyer` && /Birmingham/.test(buyer?.address ?? ''));
  const edges = await prisma.vehicleOwnership.findMany({ where: { vehicle_id: a.vehicleId }, select: { customer_id: true, is_current: true, valid_to: true, valid_from: true } });
  const current = edges.filter((e) => e.is_current);
  const ended = edges.find((e) => e.customer_id === prev.id);
  /**
   * THE BROKEN THING THIS FIXES. ensureIdentityAndCurrentOwner writes an owner only when there is
   * NONE — so on this car it would have kept the previous keeper, and the buyer would never appear.
   */
  check('  …the previous keeper’s record is ENDED, dated the sale', ended?.is_current === false && ended?.valid_to?.toISOString() === soldAt.toISOString(),
    `current=${ended?.is_current} valid_to=${ended?.valid_to?.toISOString?.()}`);
  check('  …and exactly one current owner, the buyer, from the sale date', current.length === 1 && current[0].customer_id === A.customerId
    && current[0].valid_from.toISOString() === soldAt.toISOString(), `${current.length} current`);
  const card = await prisma.jobCard.findUnique({ where: { id: A.cardId }, select: { status: true, sale_of_stock_item_id: true, stock_item_id: true, customer_id: true } });
  check('3 · the sale card is marked as a SALE, never as prep', card?.sale_of_stock_item_id === a.itemId && card?.stock_item_id === null && card?.customer_id === A.customerId,
    'stock_item_id would have made refuseIfInternalStock refuse the mint');
  const inv = await prisma.invoice.findUnique({ where: { id: A.invoiceId }, select: { series: true, vat_position: true, stock_disposal_id: true, invoice_number: true, customer_name_snapshot: true, customer_address_snapshot: true } });
  check('4 · the invoice: vehicle_sale, margin, naming this disposal', inv?.series === 'vehicle_sale' && inv?.vat_position === 'margin' && inv?.stock_disposal_id === disp?.id,
    `${inv?.invoice_number} ${inv?.series}/${inv?.vat_position}`);
  check('  …addressed to the buyer, frozen at issue', inv?.customer_name_snapshot === `${PREFIX} New Buyer` && /Birmingham/.test(inv?.customer_address_snapshot ?? ''));
  const lines = await prisma.invoiceLine.findMany({ where: { invoice_id: A.invoiceId }, select: { vat_rate: true, line_vat: true, line_total: true } });
  check('  …one line, the whole price at 0% — the VAT is on the margin, in the book',
    lines.length === 1 && Number(lines[0].vat_rate) === 0 && Number(lines[0].line_vat) === 0 && Number(lines[0].line_total) === 8000,
    JSON.stringify(lines.map((l) => [Number(l.line_total), Number(l.vat_rate)])));
  check('  …and the audit trail records the sale', (await prisma.auditLog.count({ where: { group_id: ZZ_GROUP, action: 'stock.sold', entity_id: A.cardId } })) === 1);
  const ccIds = (await prisma.vehicle.findMany({ where: { group_id: ZZ_GROUP, id: a.vehicleId, ...CC.CUSTOMER_CARS }, select: { id: true } })).length;
  check('the sold car is a customer’s car again — its MOT is now the buyer’s lead', ccIds === 1);
  const wipIds = (await prisma.jobCard.findMany({ where: WIP.wipCardsWhere([site.id]), select: { id: true } })).map((c) => c.id);
  check('  …and the sale card is not counted as work in progress', !wipIds.includes(A.cardId));

  console.log('\n— A SALE TO SOMEONE ALREADY ON THE BOOKS —');
  const q = await car('qualifying');
  const known = await mkCustomer('Known Customer', '5 Regular Lane');
  const customersBefore = await prisma.customer.count({ where: { group_id: ZZ_GROUP } });
  const sq = await SALE.sellCar({ groupId: ZZ_GROUP, userId: user.id, siteId: site.id, stockItemId: q.itemId, soldAt, salePence: 800000, buyer: { customerId: known.id } });
  check('the sale completes', 'invoiceId' in sq, 'refused' in sq ? sq.refused : 'sold');
  const Q = ids(sq);
  check('  …and links to THAT customer rather than creating another', Q.customerId === known.id
    && (await prisma.customer.count({ where: { group_id: ZZ_GROUP } })) === customersBefore,
    'a second copy of the same person splits their service history');
  const cq = await prisma.vehicleOwnership.findFirst({ where: { vehicle_id: q.vehicleId, is_current: true }, select: { customer_id: true } });
  check('  …and the car is now theirs', cq?.customer_id === known.id);
  const lq2 = await prisma.invoiceLine.findMany({ where: { invoice_id: Q.invoiceId }, select: { vat_rate: true, line_vat: true, line_total: true } });
  const invQ = await prisma.invoice.findUnique({ where: { id: Q.invoiceId }, select: { vat_position: true } });
  check('a qualifying car’s line carries VAT at 20% and totals the price',
    invQ?.vat_position === 'qualifying' && lq2.length === 1 && Number(lq2[0].vat_rate) === 20
      && Math.round(Number(lq2[0].line_total) * 100) + Math.round(Number(lq2[0].line_vat) * 100) === 800000,
    JSON.stringify(lq2.map((l) => [Number(l.line_total), Number(l.line_vat), Number(l.vat_rate)])));

  console.log('\n— WHAT IT REFUSES, AND THAT A REFUSAL WRITES NOTHING —');
  const r1 = await car();
  const noAddr = await mkCustomer('No Address', null);
  const refNoAddr = await SALE.sellCar({ groupId: ZZ_GROUP, userId: user.id, siteId: site.id, stockItemId: r1.itemId, soldAt, salePence: 500000, buyer: { customerId: noAddr.id } });
  check('a PICKED customer with no address refuses — picking is not a way round it', 'refused' in refNoAddr && refNoAddr.refused === RULES.PICKED_BUYER_NO_ADDRESS,
    'refused' in refNoAddr ? refNoAddr.refused.slice(0, 80) : 'SOLD');
  check('  …and the disposal it wrote first rolled back', (await prisma.stockDisposal.count({ where: { stock_item_id: r1.itemId } })) === 0);
  const refZero = await SALE.sellCar({ groupId: ZZ_GROUP, userId: user.id, siteId: site.id, stockItemId: r1.itemId, soldAt, salePence: 0, buyer: { customerId: known.id } });
  check('no price refuses', 'refused' in refZero);
  const refEarly = await SALE.sellCar({ groupId: ZZ_GROUP, userId: user.id, siteId: site.id, stockItemId: r1.itemId, soldAt: new Date('2026-01-01'), salePence: 500000, buyer: { customerId: known.id } });
  check('a sale dated before the car arrived refuses', 'refused' in refEarly && /before it arrived/.test(refEarly.refused));
  const again = await SALE.sellCar({ groupId: ZZ_GROUP, userId: user.id, siteId: site.id, stockItemId: a.itemId, soldAt, salePence: 800000, buyer: { customerId: known.id } });
  check('a car already sold cannot be sold again', 'refused' in again && /already left stock/.test(again.refused));
  check('  …and still has exactly one invoice', (await prisma.invoice.count({ where: { stock_disposal_id: disp?.id ?? NONE } })) === 1);

  /**
   * ═══ THE CLAUSE THIS GATE EXISTS FOR ═══════════════════════════════════════════════════════════
   * The mint is the LAST write. Make it throw, and everything before it — the disposal, the ended and
   * opened ownership records, the new customer, the card — must be gone. Two failure shapes: a crash,
   * and a worded refusal.
   */
  console.log('\n— A FAILED MINT LEAVES NOTHING BEHIND —');
  /**
   * THE FAILING MINT RUNS THE REAL ONE FIRST. A stub that only threw would never spend a number, so
   * "no number was spent" could not fail. This one mints a genuine, numbered invoice with frozen lines
   * inside the transaction and THEN throws — so the invoice, its lines and the counter all have to
   * roll back with everything else.
   */
  const ISS = await import(`${R}/lib/invoice-issue.ts`);
  const mintThen = (err) => async (tx, cardId, gid) => { await ISS.issueVehicleSaleInvoice(tx, cardId, gid); throw err; };
  for (const [label, failing] of [
    ['a CRASH at the mint', mintThen(new Error('ZZ forced mint failure'))],
    ['a REFUSAL at the mint', mintThen(new Error('IMPORT_ASSERT:ZZ forced mint refusal'))],
  ]) {
    const f = await car();
    const keeper = await mkCustomer(`Keeper ${label.slice(2, 7)}`, '2 Keeper Close');
    await prisma.vehicleOwnership.create({ data: { vehicle_id: f.vehicleId, customer_id: keeper.id, is_current: true } });
    const seqBefore = (await prisma.invoiceSequence.findUnique({ where: { group_id: ZZ_GROUP }, select: { vehicle_sale_last_value: true } }))?.vehicle_sale_last_value ?? 0;
    const custBefore = await prisma.customer.count({ where: { group_id: ZZ_GROUP } });
    let threw = null, result = null;
    try {
      result = await SALE.sellCar({ groupId: ZZ_GROUP, userId: user.id, siteId: site.id, stockItemId: f.itemId, soldAt, salePence: 600000,
        buyer: { name: `${PREFIX} Doomed Buyer`, address: '3 Nowhere' } }, { mint: failing });
    } catch (e) { threw = describeError(e); }
    const outcome = threw ? `threw: ${threw.slice(0, 40)}` : ('refused' in (result ?? {}) ? `refused: ${result.refused}` : 'IT SOLD');
    check(`${label}: the sale does not report success`, !!threw || ('refused' in (result ?? {})), outcome);
    check('  …no disposal survives', (await prisma.stockDisposal.count({ where: { stock_item_id: f.itemId } })) === 0);
    const fe = await prisma.vehicleOwnership.findMany({ where: { vehicle_id: f.vehicleId }, select: { customer_id: true, is_current: true, valid_to: true } });
    check('  …no owner change survives: the keeper is still current, and alone',
      fe.length === 1 && fe[0].customer_id === keeper.id && fe[0].is_current === true && fe[0].valid_to === null,
      JSON.stringify(fe.map((e) => [e.customer_id === keeper.id ? 'keeper' : 'OTHER', e.is_current])));
    check('  …no sale card survives', (await prisma.jobCard.count({ where: { sale_of_stock_item_id: f.itemId } })) === 0);
    check('  …no invoice survives, though one was minted and numbered inside the transaction',
      (await prisma.invoice.count({ where: { group_id: ZZ_GROUP, series: 'vehicle_sale', job_card: { vehicle_id: f.vehicleId } } })) === 0);
    check('  …no customer survives', (await prisma.customer.count({ where: { group_id: ZZ_GROUP } })) === custBefore);
    check('  …and no invoice number was spent',
      ((await prisma.invoiceSequence.findUnique({ where: { group_id: ZZ_GROUP }, select: { vehicle_sale_last_value: true } }))?.vehicle_sale_last_value ?? 0) === seqBefore);
  }
  check('the genuine sales above DID spend their numbers, so that clause could fail',
    ((await prisma.invoiceSequence.findUnique({ where: { group_id: ZZ_GROUP }, select: { vehicle_sale_last_value: true } }))?.vehicle_sale_last_value ?? 0) >= counterBefore + 2);

  // ════════════════════════════════════════════════════════════════════════════════════════════
  // THE WAY A PERSON DOES IT — last, because a browser leg that throws ends the run
  // ════════════════════════════════════════════════════════════════════════════════════════════
  console.log('\n— ON THE CAR’S OWN PAGE, WITH A PREP CARD STILL OPEN —');
  const ui = await car('margin');
  const prep = await prisma.jobCard.create({ data: { group_id: ZZ_GROUP, site_id: site.id, vehicle_id: ui.vehicleId, stock_item_id: ui.itemId, status: 'accepted' }, select: { id: true } });
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
  await page.goto(`${origin}/admin/stock/${ui.itemId}`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-testid="sell-car"]', { timeout: 25000 });
  await page.waitForSelector('[data-testid="sale-prep-warning"]', { timeout: 10000 }).catch(() => {});
  const warnText = await page.locator('[data-testid="sale-prep-warning"]').textContent().catch(() => null);
  check('the open prep card is warned about, by registration, in words', !!warnText && warnText.startsWith(`${ui.reg} has an open prep card.`) && /will not reach the book/.test(warnText),
    (warnText ?? 'NO WARNING').slice(0, 90));
  const kindOptions = await page.locator('[data-testid="sell-car"] select').count();
  check('  …and there is no kind to choose on the panel', kindOptions === 0, `${kindOptions} select(s)`);
  await page.click('[data-testid="sale-buyer-new"]');
  await page.fill('[data-testid="sale-new-name"]', `${PREFIX} Saturday Buyer`);
  await page.fill('[data-testid="sale-new-address"]', '7 Cash Street\nDudley');
  await page.fill('[data-testid="sale-price"]', '4000');
  await page.fill('[data-testid="sale-date"]', '2026-09-12');
  const enabled = await page.locator('[data-testid="sale-submit"]').isEnabled();
  /** WARN, NOT REFUSE. A buyer with cash on a Saturday does not wait for a card to be closed. */
  check('the warning does not block — the button is live with the card still open', enabled);
  // ONLY CLICK WHAT CAN BE CLICKED. Clicking a disabled button waits 30s and THROWS, which ended the
  // run in red-proofing and hid every clause below. A disabled button is already a failure, recorded above.
  if (enabled) {
    await Promise.all([
      page.waitForURL((u) => urlUnder(u.toString(), '/admin/invoices'), { timeout: 45000 }).catch(() => {}),
      page.click('[data-testid="sale-submit"]').catch(() => {}),
    ]);
  }
  check('selling lands on the invoice it raised', urlUnder(page.url(), '/admin/invoices'), page.url());
  await page.waitForSelector('[data-testid="margin-scheme-statement"], [data-testid="vat-rate-line"]', { timeout: 25000 }).catch(() => {});
  const shown = await page.evaluate(() => ({
    statement: !!document.querySelector('[data-testid="margin-scheme-statement"]'),
    rateLines: document.querySelectorAll('[data-testid="vat-rate-line"]').length,
    body: document.body.innerText,
  }));
  check('  …which prints as a margin sale: the statement, and no VAT line', shown.statement && shown.rateLines === 0,
    `statement ${shown.statement ? 'present' : 'ABSENT'}, ${shown.rateLines} VAT line(s)`);
  check('  …addressed to the Saturday buyer', shown.body.includes(`${PREFIX} Saturday Buyer`));
  const prepStill = await prisma.jobCard.findUnique({ where: { id: prep.id }, select: { status: true } });
  check('the prep card was left exactly as it was', prepStill?.status === 'accepted', String(prepStill?.status));
  await page.goto(`${origin}/admin/stock/${ui.itemId}`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-testid="detail-sold"]', { timeout: 25000 }).catch(() => {});
  check('the car’s page now shows it sold, and offers no second sale',
    (await page.locator('[data-testid="detail-sold"]').count()) === 1 && (await page.locator('[data-testid="sell-car"]').count()) === 0);

} catch (e) {
  check('run completed', false, describeError(e).slice(0, 300));
} finally {
  await browser?.close().catch(() => {});
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
        await prisma.stockDisposal.deleteMany({ where: { stock_item_id: { in: its } } });
        await prisma.stockItem.deleteMany({ where: { id: { in: its } } });
        await prisma.vehicle.deleteMany({ where: { id: { in: ids } } });
        const idents = vs.map((v) => v.identity_id).filter(Boolean);
        if (idents.length) await prisma.vehicleIdentity.deleteMany({ where: { id: { in: idents }, vehicles: { none: {} } } });
      }
      await prisma.customer.deleteMany({ where: { group_id: ZZ_GROUP, name: { startsWith: PREFIX }, ownerships: { none: {} }, job_cards: { none: {} } } });
      const leftV = await prisma.vehicle.count({ where: { group_id: ZZ_GROUP, registration: { startsWith: PREFIX } } });
      const leftC = await prisma.customer.count({ where: { group_id: ZZ_GROUP, name: { startsWith: PREFIX } } });
      check('teardown left ZZ with none of this gate’s cars or customers', leftV === 0 && leftC === 0, `${ids.length} car(s) removed; ${leftV} car(s), ${leftC} customer(s) left`);
    } catch (e) { check('teardown completed', false, describeError(e).slice(0, 200)); }
  }
}
console.log(`\n${out.filter((c) => c === 'F').length} failures of ${out.length}`);
await prisma?.$disconnect();
process.exit(out.includes('F') ? 1 : 0);
