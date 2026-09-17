/**
 * File: scripts/after-sale-gate.mjs
 * @gate-requires: db, server
 *
 * AFTER THE SALE — comeback and warranty work on a car we had already sold, shown BESIDE the frozen sale
 * profit and never inside it.
 *
 * ── WHAT THIS IS FOR ────────────────────────────────────────────────────────────────────────────
 * NU14KUF sold on 7 July and came back on 18 August (W9). The sale's figures froze at disposal, so a past
 * quarter re-runs the same — and nothing showed what the car cost afterwards. The clauses this gate
 * exists for:
 *  · the right cards: a comeback or a warranty invoice, on or after the sale day, before the car next
 *    came into stock; not a paid job, not cancelled, not the sale card
 *  · the right lines: FROZEN invoice lines once invoiced, live items until then
 *  · costed EXACTLY as prep: parts at trade cost, unknowns counted not zeroed, labour HOURS shown and
 *    NOT costed, with prep's reason
 *  · the frozen sale figures do not move, and the page and the sold dashboard say "after the sale"
 *
 * FIXTURES ON ZZ ONLY, prefix ZZAS, swept before and after. Every expected figure is worked by hand.
 */
import './_gate-preflight.mjs';
const { gatePrisma, describeError, ZZ_GROUP, gateOrigin, serverReady } = await import('./_gate-preflight.mjs');
import './_ts.mjs';
const { chromium } = await import('/Users/hugh/Developer/greasedesk-core/node_modules/playwright-core/index.mjs');

const out = [];
const check = (n, ok, d = '') => { out.push(ok ? 'P' : 'F'); console.log(`${ok ? '✓' : '✗'} ${n}${d ? `  — ${d}` : ''}`); };
const PREFIX = 'ZZAS';
const R = '/Users/hugh/Developer/greasedesk-core';
const AS = await import(`${R}/lib/stock-after-sale-rules.ts`);
const S = await import(`${R}/lib/stock.ts`);

let prisma;
let browser = null;
try {
  // ════════════════════════════════════════════════════════════════════════════════════════════
  // PURE — cheapest first
  // ════════════════════════════════════════════════════════════════════════════════════════════
  console.log('— HOURS ARE REPORTED, NEVER PRICED —');
  check('a labour line carries its hours in qty', AS.lineHours({ item_type: 'labour', qty: '1.5', unit_cost: null }) === 1.5);
  check('a fixed line carries labour_hours per unit', AS.lineHours({ item_type: 'fixed', qty: '2', unit_cost: '0', labour_hours: '0.5' }) === 1);
  check('a part carries none', AS.lineHours({ item_type: 'part', qty: '3', unit_cost: '10', labour_hours: null }) === 0);
  check('the labour note is prep’s ruling, with prep’s reason word for word',
    AS.AFTER_SALE_LABOUR_NOTE === 'Labour after the sale is not costed. There is no measured workshop rate yet, and a typed one would look like a measurement.'
      && AS.AFTER_SALE_LABOUR_NOTE.endsWith(S.LABOUR_AT_ZERO_NOTE.replace(/^Prep labour is not costed\. /, '')), AS.AFTER_SALE_LABOUR_NOTE);
  const f = AS.afterSaleFigures([{ cardId: 'a', createdAt: new Date('2026-06-10'), isComeback: true, invoiceNumber: 'W1', lines: [
    { item_type: 'part', qty: '2', unit_cost: '30', labour_hours: null },
    { item_type: 'part', qty: '1', unit_cost: null, labour_hours: null },
    { item_type: 'fixed', qty: '1', unit_cost: '0', labour_hours: '0.5' },
    { item_type: 'labour', qty: '1', unit_cost: null, labour_hours: null },
  ] }]);
  check('parts at trade cost: 2 × £30 = £60', f.partsPence === 6000, `${f.partsPence}`);
  check('  …a part with no trade cost is COUNTED, not valued at nothing — and so is a fixed-price line', f.unknownCostLines === 2, `${f.unknownCostLines}`);
  check('  …hours: 0.5 on the fixed line + 1 of labour = 1.5, and no money for them', f.hours === 1.5 && f.labourLines === 1, `${f.hours}h`);
  check('the summary says the hours are not costed', AS.afterSaleSummary({ partsPence: 7250, unknownCostLines: 2, hours: 2 }, 2)
    === '2 cards: £72.50 of parts, and 2 lines with no trade cost recorded; 2 h of labour, not costed.', AS.afterSaleSummary({ partsPence: 7250, unknownCostLines: 2, hours: 2 }, 2));

  console.log('\n— THE WINDOW —');
  const sold = new Date('2026-06-01T15:00:00Z');
  check('a card the same day as the sale counts', AS.inAfterSaleWindow(new Date('2026-06-01T09:00:00Z'), sold, null));
  check('a card the day before does not', !AS.inAfterSaleWindow(new Date('2026-05-31T23:00:00Z'), sold, null));
  check('a card after the car came BACK into stock belongs to that holding, not this sale', !AS.inAfterSaleWindow(new Date('2026-07-05'), sold, new Date('2026-07-01')));
  check('  …while one before it does', AS.inAfterSaleWindow(new Date('2026-06-20'), sold, new Date('2026-07-01')));

  // ════════════════════════════════════════════════════════════════════════════════════════════
  prisma = await gatePrisma();
  const SALE = await import(`${R}/lib/stock-sale.ts`);
  const ST = await import(`${R}/lib/stock-store.ts`);
  const ISS = await import(`${R}/lib/invoice-issue.ts`);

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
  const NONE = '00000000-0000-0000-0000-000000000000';
  const otherDisposals = await prisma.stockDisposal.count({ where: { group_id: ZZ_GROUP } });
  check('premise: ZZ holds no other disposal, so the dashboard totals are this gate’s alone', otherDisposals === 0, `${otherDisposals} found`);

  console.log('\n— A SOLD CAR —');
  const reg = `${PREFIX}01M`;
  const v = await prisma.vehicle.create({ data: { group_id: ZZ_GROUP, registration: reg, registration_normalized: reg, make: 'BMW', model: '114i' }, select: { id: true } });
  const item = await ST.takeIntoStock({ groupId: ZZ_GROUP, userId: user.id, vehicleId: v.id, acquiredAt: new Date('2026-03-01T00:00:00Z'), purchasePence: 110000, vatStatus: 'margin', source: 'private' });
  if ('refused' in item) throw new Error(item.refused);
  const soldAt = new Date('2026-06-01T00:00:00Z');
  const sale = await SALE.sellCar({ groupId: ZZ_GROUP, userId: user.id, siteId: site.id, stockItemId: item.id, soldAt, salePence: 450000,
    buyer: { name: `${PREFIX} Buyer`, address: '57 Test Close\nBirmingham' } });
  check('the sale completes', 'invoiceId' in sale, 'refused' in sale ? sale.refused : '');
  const buyerId = 'customerId' in sale ? sale.customerId : NONE;
  const range = [new Date('2026-06-01T00:00:00Z'), new Date('2026-06-30T23:59:59Z')];
  const before = await ST.soldInPeriod(ZZ_GROUP, range[0], range[1]);
  const detail0 = await ST.stockDetail(ZZ_GROUP, item.id, new Date(), { vatRegistered: true });
  check('sold, with no work since: the reader says so rather than showing nothing', detail0?.afterSale?.cards.length === 0);

  const card = (over, items) => prisma.jobCard.create({ data: {
    group_id: ZZ_GROUP, site_id: site.id, customer_id: buyerId, vehicle_id: v.id, status: 'accepted',
    ...over, items: { create: items },
  }, select: { id: true } });

  // C1 — a comeback, INVOICED on the warranty series through the same mint the status API uses.
  const c1 = await card({ is_comeback: true, created_at: new Date('2026-06-10T10:00:00Z') }, [
    { item_type: 'part', description: 'Clutch slave cylinder', qty: 2, unit_cost: 30, unit_price: 45 },
    { item_type: 'labour', description: 'Fit', qty: 1.5, unit_cost: null, unit_price: 90 },
    { item_type: 'fixed', description: 'Diagnostic Report', qty: 1, unit_cost: 0, unit_price: 66.67, labour_hours: 0.5 },
  ]);
  await prisma.$transaction((tx) => ISS.issueWarrantyInvoiceForCard(tx, c1.id, ZZ_GROUP, { goodwill: 'Less: warranty — goodwill, no charge', noCharge: 'No charge' }));
  await prisma.jobCard.update({ where: { id: c1.id }, data: { status: 'invoiced' } });
  const w = await prisma.invoice.findUnique({ where: { job_card_id: c1.id }, select: { invoice_number: true, series: true } });
  check('fixture: the comeback minted on the warranty series', w?.series === 'warranty', `${w?.invoice_number} ${w?.series}`);
  // Edited AFTER it was invoiced: the frozen lines are what count.
  await prisma.jobCardItem.create({ data: { job_card_id: c1.id, item_type: 'part', description: 'Added after invoicing', qty: 1, unit_cost: 999, unit_price: 999 } });

  // C2 — a comeback not yet invoiced: live items, one part without a trade cost.
  const c2 = await card({ is_comeback: true, created_at: new Date('2026-06-20T10:00:00Z') }, [
    { item_type: 'part', description: 'Bulb', qty: 1, unit_cost: 12.5, unit_price: 20 },
    { item_type: 'part', description: 'Uncatalogued clip', qty: 1, unit_cost: null, unit_price: 5 },
  ]);

  // NOT AFTER-SALE WORK
  const paid = await card({ is_comeback: false, created_at: new Date('2026-06-15T10:00:00Z') }, [{ item_type: 'part', description: 'Service parts, paid for', qty: 1, unit_cost: 500, unit_price: 700 }]);
  const beforeSale = await card({ is_comeback: true, created_at: new Date('2026-05-20T10:00:00Z') }, [{ item_type: 'part', description: 'Before the sale', qty: 1, unit_cost: 700, unit_price: 700 }]);
  const cancelled = await card({ is_comeback: true, status: 'cancelled', created_at: new Date('2026-06-12T10:00:00Z') }, [{ item_type: 'part', description: 'Cancelled', qty: 1, unit_cost: 800, unit_price: 800 }]);
  // The car came BACK into stock on 1 July; its later comeback belongs to that holding.
  await prisma.stockItem.create({ data: { group_id: ZZ_GROUP, vehicle_id: v.id, acquired_at: new Date('2026-07-01T00:00:00Z'), purchase_pence: 300000, vat_status: 'margin', source: 'buyback', created_by_user_id: user.id } });
  const afterReturn = await card({ is_comeback: true, created_at: new Date('2026-07-05T10:00:00Z') }, [{ item_type: 'part', description: 'After it came back', qty: 1, unit_cost: 900, unit_price: 900 }]);

  console.log('\n— THE READER —');
  const d = await ST.stockDetail(ZZ_GROUP, item.id, new Date(), { vatRegistered: true });
  const a = d?.afterSale;
  const ids = (a?.cards ?? []).map((c) => c.cardId);
  check('exactly the two after-sale cards, in date order', JSON.stringify(ids) === JSON.stringify([c1.id, c2.id]), `${ids.length} card(s)`);
  check('  …not the paid job, the card before the sale, the cancelled one, or the one after the car came back',
    ![paid.id, beforeSale.id, cancelled.id, afterReturn.id].some((x) => ids.includes(x)));
  const a1 = a?.cards.find((c) => c.cardId === c1.id);
  check('the invoiced card reads its FROZEN lines: £60 of parts, not the £999 added afterwards', a1?.cost.partsPence === 6000 && a1?.invoiced === true && a1?.invoiceNumber === w?.invoice_number,
    `${a1?.cost.partsPence}p`);
  check('  …1.5 h of labour and 0.5 h in the diagnostic: 2 h, not costed', a1?.hours === 2, `${a1?.hours}`);
  const a2 = a?.cards.find((c) => c.cardId === c2.id);
  check('the card not yet invoiced reads its live items, and says it is not invoiced', a2?.cost.partsPence === 1250 && a2?.invoiced === false, `${a2?.cost.partsPence}p`);
  // C1: the fixed diagnostic line has no trade cost figure (1). C2: the uncatalogued clip (1). The goodwill line is £0 known.
  check('TOTALS: £72.50 of parts, 2 lines without a trade cost, 2 h not costed', a?.partsPence === 7250 && a?.unknownCostLines === 2 && a?.hours === 2,
    JSON.stringify({ parts: a?.partsPence, unknown: a?.unknownCostLines, hours: a?.hours }));

  console.log('\n— THE FROZEN SALE DID NOT MOVE —');
  const after = await ST.soldInPeriod(ZZ_GROUP, range[0], range[1]);
  check('the period’s gross profit is exactly what it was before any comeback was entered', after.summary.profitPence === before.summary.profitPence,
    `${before.summary.profitPence} → ${after.summary.profitPence}`);
  check('  …and the car’s own row too', JSON.stringify(after.rows.find((r) => r.stockItemId === item.id)) === JSON.stringify(before.rows.find((r) => r.stockItemId === item.id)));
  check('the period carries after-sale work as its OWN figure', after.afterSale.cars === 1 && after.afterSale.cards === 2 && after.afterSale.partsPence === 7250 && after.afterSale.hours === 2,
    JSON.stringify(after.afterSale));
  check('  …which was nothing before', before.afterSale.cars === 0 && before.afterSale.partsPence === 0);
  check('a car still in stock has no after-sale section at all', (await ST.stockDetail(ZZ_GROUP, (await prisma.stockItem.findFirst({ where: { vehicle_id: v.id, disposal: { is: null } }, select: { id: true } })).id, new Date(), { vatRegistered: true }))?.afterSale === null);

  // ════════════════════════════════════════════════════════════════════════════════════════════
  console.log('\n— ON SCREEN —');
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

  await page.goto(`${origin}/admin/stock/${item.id}`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-testid="after-sale"]', { timeout: 25000 }).catch(() => {});
  const shown = await page.evaluate((cid) => ({
    title: document.querySelector('[data-testid="after-sale"] h2')?.textContent ?? null,
    summary: document.querySelector('[data-testid="after-sale-summary"]')?.textContent ?? null,
    labour: document.querySelector('[data-testid="after-sale-labour-note"]')?.textContent ?? null,
    c2: document.querySelector(`[data-testid="after-sale-card-${cid}"]`)?.textContent ?? null,
  }), c2.id);
  check('the car page has a section titled "After the sale"', shown.title === 'After the sale', shown.title ?? 'NOT SHOWN');
  check('  …with the totals worked by hand', shown.summary === '2 cards: £72.50 of parts, and 2 lines with no trade cost recorded; 2 h of labour, not costed.', shown.summary ?? '');
  check('  …the labour note, saying why hours are not money', shown.labour === AS.AFTER_SALE_LABOUR_NOTE, shown.labour ?? '');
  check('  …and the uninvoiced card marked as such', /not yet invoiced/.test(shown.c2 ?? ''), shown.c2 ?? '');

  await page.goto(`${origin}/admin/stock`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-testid="tab-gone"]', { timeout: 25000 });
  await page.click('[data-testid="tab-gone"]');
  await page.waitForSelector('[data-testid="sold-period"]', { timeout: 15000 });
  await page.selectOption('[data-testid="sold-period"]', 'all_time');
  await page.waitForFunction(() => !!document.querySelector('[data-testid="sold-after-sale-summary"]'), null, { timeout: 15000 }).catch(() => {});
  const dash = await page.evaluate(() => ({
    summary: document.querySelector('[data-testid="sold-after-sale-summary"]')?.textContent ?? null,
    profitTile: document.querySelector('[data-testid="sold-profit"]')?.textContent ?? null,
  }));
  check('the sold dashboard shows it beside the profit, not in it', dash.summary === 'On 1 car sold in this period, 2 cards: £72.50 of parts, and 2 lines with no trade cost recorded; 2 h of labour, not costed.',
    dash.summary ?? 'NOT SHOWN');
  check('  …and the gross profit tile reads the frozen figure', (dash.profitTile ?? '').includes(`£${Math.round(after.summary.profitPence / 100).toLocaleString('en-GB')}`), dash.profitTile ?? '');
} catch (e) {
  check('run completed', false, describeError(e).slice(0, 300));
} finally {
  await browser?.close().catch(() => {});
  if (prisma) {
    try {
      const vs = await prisma.vehicle.findMany({ where: { group_id: ZZ_GROUP, registration: { startsWith: PREFIX } }, select: { id: true, identity_id: true } });
      const ids = vs.map((x) => x.id);
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
        const idents = vs.map((x) => x.identity_id).filter(Boolean);
        if (idents.length) await prisma.vehicleIdentity.deleteMany({ where: { id: { in: idents }, vehicles: { none: {} } } });
      }
      await prisma.customer.deleteMany({ where: { group_id: ZZ_GROUP, name: { startsWith: PREFIX }, ownerships: { none: {} }, job_cards: { none: {} } } });
      const leftV = await prisma.vehicle.count({ where: { group_id: ZZ_GROUP, registration: { startsWith: PREFIX } } });
      const leftC = await prisma.customer.count({ where: { group_id: ZZ_GROUP, name: { startsWith: PREFIX } } });
      check('teardown left ZZ with none of this gate’s cars or customers', leftV === 0 && leftC === 0, `${ids.length} car(s) removed; ${leftV} car(s), ${leftC} customer(s) left`);
    } catch (e2) { check('teardown completed', false, describeError(e2).slice(0, 200)); }
  }
}
console.log(`\n${out.filter((c) => c === 'F').length} failures of ${out.length}`);
await prisma?.$disconnect();
process.exit(out.includes('F') ? 1 : 0);
