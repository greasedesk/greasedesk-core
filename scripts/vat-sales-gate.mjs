/**
 * File: scripts/vat-sales-gate.mjs
 * @gate-requires: db, server
 *
 * CAR SALES ON THE VAT SUMMARY — qualifying in, margin in its own section, unclassified refused visibly.
 *
 * ── WHAT WAS WRONG ──────────────────────────────────────────────────────────────────────────────
 * The summary read `series: 'chargeable'` only. A QUALIFYING car's output VAT reached no return, and
 * MARGIN VAT reached nothing at all: the stock book computed it and nothing called the stock book. Every
 * car in stock was margin, so the first sale of any car would have left the return short.
 *
 * ── THE THREE ANSWERS ───────────────────────────────────────────────────────────────────────────
 *  · qualifying: its frozen 20% line joins the rate breakdown and the totals, like workshop work
 *  · margin: its 0% line stays OUT (it would add the whole price as sales with no VAT); VAT is on the
 *    margin from the stock book, in its own section, and net sales are untouched (accountant item 12)
 *  · anything else — no treatment, a stock record on the other scheme, a price that disagrees — is in NO
 *    figure and is NAMED in red on the page, the CSV and the accountant's PDF
 *
 * ── AND ONE DEFECT FOUND ON THE WAY ─────────────────────────────────────────────────────────────
 * The stock book measured margin from the purchase price ALONE. The purchase model puts an auction
 * buyer's premium inside the margin base (HMRC 718/1), so the book overstated an auction car's margin VAT
 * by a sixth of its premium. Latent — nothing showed the book — until this summary would have printed it.
 *
 * FIXTURES ON ZZ ONLY, prefix ZZVS, swept before and after. Figures are compared as DELTAS across the
 * fixtures, so other invoices on the gate tenant in the same quarter cannot make a clause pass or fail.
 */
import './_gate-preflight.mjs';
const { gatePrisma, describeError, ZZ_GROUP, gateOrigin, serverReady } = await import('./_gate-preflight.mjs');
import './_ts.mjs';
const { chromium } = await import('/Users/hugh/Developer/greasedesk-core/node_modules/playwright-core/index.mjs');

const out = [];
const check = (n, ok, d = '') => { out.push(ok ? 'P' : 'F'); console.log(`${ok ? '✓' : '✗'} ${n}${d ? `  — ${d}` : ''}`); };
const gbp = (p) => (p == null ? 'null' : `£${(p / 100).toFixed(2)}`);
const R = '/Users/hugh/Developer/greasedesk-core';
const PREFIX = 'ZZVS';
const NONE = '00000000-0000-0000-0000-000000000000';

const SC = await import(`${R}/lib/invoice-series-scope.ts`);
const NUM = await import(`${R}/lib/invoice-number.ts`);
const S = await import(`${R}/lib/stock.ts`);
const PM = await import(`${R}/lib/purchase-model.ts`);
const W = await import(`${R}/lib/vat-summary-words.ts`);

let prisma;
let browser = null;
try {
  console.log('— HOW EACH INVOICE IS DECLARED —');
  check('the VAT rule answers for EVERY series', JSON.stringify(Object.keys(SC.VAT_RETURN_TREATMENT).sort()) === JSON.stringify([...NUM.INVOICE_SERIES].sort()));
  const t = (series, vatPosition, registeredAtIssue = true) => SC.vatTreatment(series, { vatPosition, registeredAtIssue });
  check('workshop work: its lines, as before', t('chargeable', null) === 'output_lines' && t('chargeable', null, false) === 'output_lines');
  check('warranty and historical are not declared here', t('warranty', null) === 'not_declared' && t('historical', null) === 'not_declared');
  check('a QUALIFYING car sale: its lines, like workshop work', t('vehicle_sale', 'qualifying') === 'output_lines');
  check('a MARGIN car sale: the margin section, never its lines', t('vehicle_sale', 'margin') === 'margin_scheme');
  /** THE REFUSAL. Never defaulted to margin (which under-declares a qualifying car), never counted as lines. */
  check('a car sale with NO recorded treatment is unclassified', t('vehicle_sale', null) === 'unclassified');
  check('  …and so is one reading "none", "unsettled" or a typo', ['none', 'unsettled', 'Margin', 'qualifiying'].every((v) => t('vehicle_sale', v) === 'unclassified'));
  check('an UNKNOWN series is refused visibly too, not skipped', t('part_exchange', 'margin') === 'unclassified');
  check('an unregistered garage declares no car-sale VAT under either scheme', t('vehicle_sale', 'margin', false) === 'not_declared' && t('vehicle_sale', 'qualifying', false) === 'not_declared',
    'it cannot use the margin scheme and charged no VAT');

  console.log('\n— THE MARGIN IS MEASURED FROM THE PRICE OF THE GOODS, PREMIUM INCLUDED —');
  check('an auction premium enters the margin base', PM.marginBaseFeePence('auction', 30000) === 30000);
  check('  …a private seller’s stale premium field does not', PM.marginBaseFeePence('private', 30000) === 0, 'a private seller invoices no premium');
  check('the purchase model and the stock book read ONE rule', PM.SOURCES.every((src) => PM.feePosition(src, { premiumPence: 30000, servicesPence: 12000 }, true).inMarginBasePence === PM.marginBaseFeePence(src, 30000)));
  const withPremium = S.bookRow({ purchasePence: 300000, inMarginBasePence: 30000, vatStatus: 'margin', disposal: { kind: 'sold', salePence: 450000 } });
  const ignoringIt = S.bookRow({ purchasePence: 300000, inMarginBasePence: 0, vatStatus: 'margin', disposal: { kind: 'sold', salePence: 450000 } });
  check('an auction car’s margin VAT is a sixth of sale less price AND premium', withPremium.marginPence === 120000 && withPremium.vatDuePence === 20000,
    `margin ${gbp(withPremium.marginPence)}, VAT ${gbp(withPremium.vatDuePence)}`);
  check('  …which is what the book USED to overstate', ignoringIt.vatDuePence - withPremium.vatDuePence === 5000, `${gbp(ignoringIt.vatDuePence)} vs ${gbp(withPremium.vatDuePence)} — a sixth of the £300 premium`);

  // ════════════════════════════════════════════════════════════════════════════════════════════
  prisma = await gatePrisma();
  const SALE = await import(`${R}/lib/stock-sale.ts`);
  const VS = await import(`${R}/lib/vat-summary.ts`);
  const { resolveRange } = await import(`${R}/lib/dashboard-periods.ts`);

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
  const swept = await sweep();
  if (swept) console.log(`\n  (swept ${swept} fixture car(s) left by an earlier run)`);

  const site = await prisma.site.findFirst({ where: { group_id: ZZ_GROUP }, select: { id: true } });
  const user = await prisma.user.findFirst({ where: { group_id: ZZ_GROUP }, select: { id: true } });
  const grp = await prisma.group.findUnique({ where: { id: ZZ_GROUP }, select: { fy_start_month: true, vat_registered: true } });
  const siteIds = (await prisma.site.findMany({ where: { group_id: ZZ_GROUP }, select: { id: true } })).map((x) => x.id);
  const range = resolveRange({ preset: 'this_quarter' }, grp?.fy_start_month ?? 4);
  check('the gate tenant is VAT registered, so car-sale VAT is declarable at all', grp?.vat_registered === true);

  const before = await VS.getVatSummary(ZZ_GROUP, siteIds, range.from, range.to);
  let n = 0;
  const sale = async ({ source, vat, purchase, premium = 0, price }) => {
    n += 1;
    const reg = `${PREFIX}${String(n).padStart(2, '0')}${vat === 'qualifying' ? 'Q' : 'M'}`;
    const v = await prisma.vehicle.create({ data: { group_id: ZZ_GROUP, registration: reg, registration_normalized: reg, make: 'MINI', model: 'Cooper S', year: 2014 }, select: { id: true } });
    const it = await prisma.stockItem.create({ data: { group_id: ZZ_GROUP, vehicle_id: v.id, acquired_at: new Date('2026-03-01'), status: 'advertised',
      purchase_pence: purchase, premium_pence: premium, vat_status: vat, source, created_by_user_id: user.id }, select: { id: true } });
    const r = await SALE.sellCar({ groupId: ZZ_GROUP, userId: user.id, siteId: site.id, stockItemId: it.id, soldAt: new Date(), salePence: price,
      buyer: { name: `${PREFIX} Buyer ${n}`, address: `${n} Sale Road` } });
    const invoiceId = 'invoiceId' in r ? r.invoiceId : NONE;
    const inv = await prisma.invoice.findUnique({ where: { id: invoiceId }, select: { invoice_number: true, stock_disposal_id: true } });
    return { reg, itemId: it.id, invoiceId, number: inv?.invoice_number ?? 'NOT MINTED', disposalId: inv?.stock_disposal_id ?? NONE };
  };

  const M = await sale({ source: 'auction', vat: 'margin', purchase: 300000, premium: 30000, price: 450000 });
  const L = await sale({ source: 'auction', vat: 'margin', purchase: 500000, premium: 0, price: 400000 });
  const Q = await sale({ source: 'trade', vat: 'qualifying', purchase: 400000, price: 480000 });
  const U = await sale({ source: 'auction', vat: 'margin', purchase: 200000, price: 260000 });
  const D = await sale({ source: 'auction', vat: 'margin', purchase: 200000, price: 270000 });
  const P = await sale({ source: 'auction', vat: 'margin', purchase: 200000, price: 280000 });
  check('all six fixture sales minted', [M, L, Q, U, D, P].every((x) => x.invoiceId !== NONE), [M, L, Q, U, D, P].map((x) => x.number).join(' '));

  // Three ways a sale becomes unclassifiable, made the way they would actually arise.
  await prisma.invoice.update({ where: { id: U.invoiceId }, data: { vat_position: null } });                    // no treatment recorded
  await prisma.stockItem.update({ where: { id: D.itemId }, data: { vat_status: 'qualifying' } });                  // the book disagrees with the invoice
  await prisma.stockDisposal.update({ where: { id: P.disposalId }, data: { sale_pence: 285000 } });               // the price disagrees

  /**
   * TWO SOLD CARS WITH NO INVOICE. Written as ROWS, not through lib/stock-historical: this gate tests the
   * READER, and the writer is gated in historical-sale-gate — which needs a boundary sale dated BEFORE the
   * past sale, and "this quarter" cannot guarantee a day before today inside it. The broken one (unmarked)
   * has no writer at all by design; a direct row is the only way it can exist, which is the point.
   */
  const soldRow = async (sfx, marked) => {
    const reg = `${PREFIX}${sfx}`;
    const v = await prisma.vehicle.create({ data: { group_id: ZZ_GROUP, registration: reg, registration_normalized: reg, make: 'MINI', model: 'One' }, select: { id: true } });
    const it = await prisma.stockItem.create({ data: { group_id: ZZ_GROUP, vehicle_id: v.id, acquired_at: new Date('2026-03-01'), purchase_pence: 150000, vat_status: 'margin', source: 'private', created_by_user_id: user.id }, select: { id: true } });
    await prisma.stockDisposal.create({ data: { group_id: ZZ_GROUP, stock_item_id: it.id, disposed_at: new Date(), kind: 'sold', sale_pence: 250000, recorded_not_invoiced: marked, receipt_ref: marked ? 'R-9' : null, created_by_user_id: user.id } });
    return reg;
  };
  const H = await soldRow('07H', true);
  const B = await soldRow('08B', false);

  const after = await VS.getVatSummary(ZZ_GROUP, siteIds, range.from, range.to);

  console.log('\n— QUALIFYING: ITS LINE, IN THE FIGURES —');
  check('output VAT rises by exactly the qualifying car’s VAT', after.vatPennies - before.vatPennies === 80000, gbp(after.vatPennies - before.vatPennies));
  check('  …and net sales by exactly its net', after.netPennies - before.netPennies === 400000, gbp(after.netPennies - before.netPennies));
  check('  …counted as one invoice', after.invoiceCount - before.invoiceCount === 1, `${after.invoiceCount - before.invoiceCount}`);
  /**
   * THE MARGIN LINES STAY OUT. Five margin-scheme sales (£16,700 of 0% lines between them) were minted,
   * and net sales moved by the qualifying car's £4,000 net and not a penny more.
   */
  const zeroBefore = before.byRate.find((r) => r.ratePercent === 0)?.netPennies ?? 0;
  const zeroAfter = after.byRate.find((r) => r.ratePercent === 0)?.netPennies ?? 0;
  check('no margin sale’s 0% line entered the rate breakdown', zeroAfter === zeroBefore, `0% net moved by ${gbp(zeroAfter - zeroBefore)}`);

  console.log('\n— MARGIN: ITS OWN SECTION, FROM THE STOCK BOOK —');
  const row = (x) => after.marginScheme.rows.find((r) => r.invoiceNumber === x.number);
  check('the auction car is in the margin section', !!row(M), M.number);
  check('  …priced from sale less price paid AND premium', row(M)?.basePennies === 330000 && row(M)?.marginPennies === 120000,
    `paid ${gbp(row(M)?.basePennies)}, margin ${gbp(row(M)?.marginPennies)}`);
  check('  …owing a sixth of that margin', row(M)?.vatPennies === 20000, gbp(row(M)?.vatPennies));
  check('a car sold at a loss is listed, owing nothing — the floor is per car', row(L)?.marginPennies === -100000 && row(L)?.vatPennies === 0,
    `margin ${gbp(row(L)?.marginPennies)}, VAT ${gbp(row(L)?.vatPennies)}`);
  check('the section’s VAT rose by exactly those two', after.marginScheme.vatPennies - before.marginScheme.vatPennies === 20000
    && after.marginScheme.count - before.marginScheme.count === 2, `${gbp(after.marginScheme.vatPennies - before.marginScheme.vatPennies)} over ${after.marginScheme.count - before.marginScheme.count} car(s)`);
  check('the qualifying car is NOT in the margin section', !row(Q));
  check('the total including the margin scheme is lines plus margin, and only that', after.totalOutputVatPennies === after.vatPennies + after.marginScheme.vatPennies);

  console.log('\n— UNCLASSIFIED: IN NO FIGURE, AND NAMED —');
  const named = (x) => after.unclassified.find((u) => u.invoiceNumber === x.number);
  check('a sale with no recorded treatment is named', /not recorded/.test(named(U)?.reason ?? ''), named(U)?.reason ?? 'NOT NAMED');
  check('a sale whose stock record is on the OTHER scheme is named, not picked between', /bought as qualifying/.test(named(D)?.reason ?? ''), named(D)?.reason ?? 'NOT NAMED');
  check('a sale whose invoice and recorded price disagree is named', /disagree/.test(named(P)?.reason ?? ''), named(P)?.reason ?? 'NOT NAMED');
  check('  …and none of the three is in the margin section or the lines', !row(U) && !row(D) && !row(P) && after.invoiceCount - before.invoiceCount === 1);

  console.log('\n— A SALE WITH NO INVOICE: LEFT OUT BY DESIGN, OR BROKEN —');
  check('a car RECORDED as sold outside GreaseDesk is counted as left out', after.recordedNotInvoiced.count - before.recordedNotInvoiced.count === 1
    && after.recordedNotInvoiced.rows.some((r) => r.registration === H), `${before.recordedNotInvoiced.count} → ${after.recordedNotInvoiced.count}`);
  check('  …and is in NO figure — the deltas above moved by the qualifying car alone, and it is not named as a refusal',
    !after.unclassified.some((u) => u.invoiceNumber.startsWith(H)) && !after.marginScheme.rows.some((r) => r.registration === H));
  const broken = after.unclassified.find((u) => u.invoiceNumber === `${B} (no invoice)`);
  check('a sold car with NO invoice and NO marker is a broken sale, refused visibly and named', broken?.reason === W.NO_INVOICE_REASON, broken?.reason ?? 'NOT NAMED — a reader that walks only invoices cannot see it');
  check('  …and is not counted as recorded outside', !after.recordedNotInvoiced.rows.some((r) => r.registration === B));
  check('a sale that HAS its invoice is never called one without', [M, L, Q, U, D, P].every((x) => !after.unclassified.some((u) => u.invoiceNumber === `${x.reg} (no invoice)`)),
    after.unclassified.filter((u) => u.invoiceNumber.endsWith('(no invoice)')).map((u) => u.invoiceNumber).join(', '));
  const line = W.recordedOutsideLine(after.recordedNotInvoiced.count);
  check('the words: the count, and that they are not included', W.recordedOutsideLine(1) === '1 car recorded as sold outside GreaseDesk, not included.'
    && W.recordedOutsideLine(3) === '3 cars recorded as sold outside GreaseDesk, not included.', W.recordedOutsideLine(3));

  // ════════════════════════════════════════════════════════════════════════════════════════════
  console.log('\n— ON THE PAGE, THE CSV AND THE ACCOUNTANT’S PDF —');
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

  await page.goto(`${origin}/admin/reports/vat?preset=this_quarter`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-testid="vat-unclassified"]', { timeout: 25000 }).catch(() => {});
  const shown = await page.evaluate(() => ({
    refused: document.querySelector('[data-testid="vat-unclassified"]')?.textContent ?? '',
    refusedTop: document.querySelector('[data-testid="vat-unclassified"]')?.getBoundingClientRect().top ?? null,
    figuresTop: [...document.querySelectorAll('div')].find((d) => /Total output/.test(d.textContent ?? '') && d.childElementCount === 0)?.getBoundingClientRect().top ?? null,
    margin: document.querySelector('[data-testid="vat-margin-scheme"]')?.textContent ?? '',
    marginTotal: document.querySelector('[data-testid="vat-margin-total"]')?.textContent ?? '',
    totalInc: document.querySelector('[data-testid="vat-total-including-margin"]')?.textContent ?? '',
    outside: document.querySelector('[data-testid="vat-recorded-outside"]')?.textContent ?? '',
    outsideTop: document.querySelector('[data-testid="vat-recorded-outside"]')?.getBoundingClientRect().top ?? null,
  }));
  check('the page SAYS what it leaves out, naming the car', shown.outside.includes(line) && shown.outside.includes(H), shown.outside.slice(0, 100) || 'NOT SHOWN');
  check('  …above the figures it is absent from', shown.outsideTop !== null && shown.figuresTop !== null && shown.outsideTop < shown.figuresTop,
    `line at ${shown.outsideTop}, figures at ${shown.figuresTop}`);
  check('  …and names the broken sale in the red block', shown.refused.includes(`${B} (no invoice)`));
  check('the page names every unclassified sale, in red, and says they must be classified before filing',
    [U, D, P].every((x) => shown.refused.includes(x.number)) && shown.refused.includes(W.UNCLASSIFIED_ACTION),
    shown.refused.slice(0, 100));
  check('  …ABOVE the figures it is missing from', shown.refusedTop !== null && shown.figuresTop !== null && shown.refusedTop < shown.figuresTop,
    `refusal at ${shown.refusedTop}, figures at ${shown.figuresTop}`);
  check('the page shows the margin section with the auction car', shown.margin.includes(M.number) && shown.margin.includes(W.MARGIN_SECTION_TITLE));
  check('  …its VAT total and the total including it', shown.marginTotal.replace(/[^0-9.]/g, '') === (after.marginScheme.vatPennies / 100).toFixed(2)
    && shown.totalInc.replace(/[^0-9.]/g, '') === (after.totalOutputVatPennies / 100).toFixed(2), `${shown.marginTotal} / ${shown.totalInc}`);

  const csv = await (await ctx.request.get(`${origin}/api/reports/vat-summary?format=csv&preset=this_quarter`)).text();
  check('the CSV names the unclassified sales before any figure', [U, D, P].every((x) => csv.includes(x.number))
    && csv.indexOf('could not be classified') < csv.indexOf('Total sales ex-'), csv.split('\n').slice(4, 7).join(' | ').slice(0, 110));
  check('  …and carries the margin section with the auction car', csv.includes(W.MARGIN_SECTION_TITLE) && csv.includes(M.number));
  check('  …and says what it leaves out, before the figures', csv.includes(line) && csv.includes(`Recorded outside,${H}`)
    && csv.indexOf(line) < csv.indexOf('Total sales ex-'));

  const pdfRes = await ctx.request.get(`${origin}/api/reports/vat-summary-pdf?preset=this_quarter`);
  const { extractLayoutText } = await import(`${R}/lib/pdf-layout.ts`);
  const pdfText = pdfRes.ok() ? await extractLayoutText((await pdfRes.body()).buffer.slice(0)) : '';
  /** THE COPY THAT LEAVES THE BUILDING. A report whose PDF quietly lacked the refusal would be the one filed. */
  check('the accountant’s PDF carries the refusal and names the sales', /could not be classified/.test(pdfText) && [U, D, P].every((x) => pdfText.includes(x.number)),
    pdfRes.ok() ? `${pdfText.length} chars` : `HTTP ${pdfRes.status()}`);
  check('  …and says what it leaves out, naming the car', pdfText.replace(/\s+/g, ' ').includes(line) && pdfText.includes(H), pdfRes.ok() ? 'looked' : `HTTP ${pdfRes.status()}`);
  // The PDF's label style UPPERCASES the heading, so the title is matched without case — the words are the
  // same words. The ROW is matched exactly, figures included: that is the part an accountant copies.
  const pdfLines = pdfText.split('\n');
  const mLine = pdfLines.find((l) => l.includes(M.number)) ?? '';
  check('  …and the margin-scheme section with the auction car, figures and all',
    pdfText.toUpperCase().includes(W.MARGIN_SECTION_TITLE.toUpperCase())
      && ['£4,500.00', '£3,300.00', '£1,200.00', '£200.00'].every((f) => mLine.includes(f)),
    mLine.replace(/\s+/g, ' ').trim().slice(0, 120));

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
      check('teardown left ZZ with none of this gate’s cars or customers', leftV === 0 && leftC === 0, `${ids.length} car(s); ${leftV} car(s), ${leftC} customer(s) left`);
    } catch (e) { check('teardown completed', false, describeError(e).slice(0, 200)); }
  }
}
console.log(`\n${out.filter((c) => c === 'F').length} failures of ${out.length}`);
await prisma?.$disconnect();
process.exit(out.includes('F') ? 1 : 0);
