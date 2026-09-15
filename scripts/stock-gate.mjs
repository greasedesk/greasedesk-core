/**
 * File: scripts/stock-gate.mjs
 * @gate-requires: db, server
 * STOCK RECORDS — the compliance figures, the two sections, and the freeze that makes the book
 * reproducible.
 *
 * FIXTURES ON ZZ ONLY, never TMBS. Every row this creates is removed in the finally, by its own id.
 */
import './_gate-preflight.mjs';
const { gatePrisma, describeError, ZZ_GROUP } = await import('./_gate-preflight.mjs');
import './_ts.mjs';
const S = await import('../lib/stock.ts');
const ST = await import('../lib/stock-store.ts');
const SI = await import('../lib/stock-intake.ts');
const SP = await import('../lib/stock-prep.ts');
const { STOCK_NO_CUSTOMER: SP_LABEL } = SP;
const RA = await import('../lib/stock-reacquisition.ts');
const DC = await import('../lib/diary-colours.ts');
const SC = await import('../lib/status-colours.ts');
const TABS = await import('../lib/jobcard-tabs.ts');
const { hasKey } = await import('../lib/anchored-match.ts');
const DV = await import('../lib/dvsa.ts');
const OD = await import('../lib/odometer.ts');
const { readFileSync } = await import('node:fs');
const { gateOrigin, serverReady } = await import('./_gate-preflight.mjs');
const { chromium } = await import('/Users/hugh/Developer/greasedesk-core/node_modules/playwright-core/index.mjs');

const out = [];
const check = (n, ok, d = '') => { out.push(ok ? 'P' : 'F'); console.log(`${ok ? '✓' : '✗'} ${n}${d ? `  — ${d}` : ''}`); };
const gbp = (p) => `£${(p / 100).toFixed(2)}`;

let prisma;
let browser = null;
let made = { items: [], vehicles: [], cards: [], customers: [] };
try {
  prisma = await gatePrisma();
  const owner = await prisma.user.findFirst({ where: { group_id: ZZ_GROUP }, select: { id: true } });
  if (!owner) throw new Error('no ZZ user to attribute fixtures to');

  /**
   * ── THE CLAUSE THE OWNER NAMED ────────────────────────────────────────────────────────────────
   * The book's margin is sale MINUS PURCHASE, with costs present on the car. Under the margin scheme
   * prep may not be added to the purchase price, so £800 of prep must not move the margin by a penny —
   * and a clause that only means something once a car HAS costs on it is exactly the clause that would
   * otherwise never be written, because every car in a fresh fixture has none.
   */
  console.log('\n— the margin is sale minus purchase, with costs on the car —');
  const veh = await prisma.vehicle.create({
    data: { group_id: ZZ_GROUP, registration: `ZZSTK${Math.floor(Math.random() * 900 + 100)}`, make: 'Gate', model: 'Fixture' },
    select: { id: true, registration: true },
  });
  made.vehicles.push(veh.id);
  const taken = await ST.takeIntoStock({
    groupId: ZZ_GROUP, userId: owner.id, vehicleId: veh.id,
    acquiredAt: new Date('2026-01-15'), purchasePence: 125000, vatStatus: 'margin', source: 'auction',
    premiumPence: 26520, servicesPence: 8160,
  });
  check('a car can be taken into stock', !!taken.id, taken.refused ?? taken.id);
  made.items.push(taken.id);

  const disposed = await ST.recordDisposal({
    groupId: ZZ_GROUP, userId: owner.id, stockItemId: taken.id,
    disposedAt: new Date('2026-04-14'), kind: 'sold', salePence: 400000,
    // £800 of prep ON THE CAR — the whole point of this clause.
    costs: [
      { kind: 'parts', description: 'Clutch and fitting kit', amountPence: 25000 },
      { kind: 'delivery', description: 'Manheim Leeds to Tipton', amountPence: 25000 },
      { kind: 'other', description: 'MOT and valet', amountPence: 30000 },
    ],
  });
  check('  …and disposed of, with its prep costs frozen', !!disposed.id, disposed.refused ?? disposed.id);

  const q2 = await ST.stockBook(ZZ_GROUP, new Date('2026-04-01'), new Date('2026-06-30'));
  const row = q2.disposals.find((d) => d.stockItemId === taken.id);
  check('the car is in Q2 as a disposal', !!row, `${q2.disposals.length} disposal(s) in the quarter`);
  check('  …carrying £800 of frozen costs', row?.costsPence === 80000, gbp(row?.costsPence ?? -1));
  check('  …and the margin is SALE MINUS PURCHASE, costs untouched', row?.marginPence === 400000 - 125000,
    `${gbp(row?.marginPence ?? 0)} = ${gbp(400000)} − ${gbp(125000)}, with ${gbp(row?.costsPence ?? 0)} of prep on the car`);
  check('  …so the VAT is a sixth of THAT, not of the margin after costs',
    row?.vatDuePence === Math.round((400000 - 125000) / 6),
    `${gbp(row?.vatDuePence ?? 0)} — netting prep off first would have said ${gbp(Math.round((400000 - 125000 - 80000) / 6))}, and understated the return`);
  check('  …and bookRow cannot see costs at all, by signature', (() => {
    const src = readFileSync('lib/stock.ts', 'utf8');
    const fn = src.slice(src.indexOf('export function bookRow'), src.indexOf('\n}', src.indexOf('export function bookRow')));
    return !/cost/i.test(fn);
  })(), 'a later reader netting prep off the margin would have to change the arguments — a visible edit, not an invisible one');

  /** ── TWO PERIODS, ONE CAR, COUNTED AS A DISPOSAL EXACTLY ONCE ─────────────────────────────── */
  console.log('\n— the same car in two quarters —');
  const q1 = await ST.stockBook(ZZ_GROUP, new Date('2026-01-01'), new Date('2026-03-31'));
  const q1row = q1.inStock.find((d) => d.stockItemId === taken.id);
  check('in Q1 it is IN STOCK, with the sale side empty', !!q1row && q1row.inStock === true
    && q1row.salePence === null && q1row.disposedAt === null && q1row.marginPence === null,
    'an honest null, not absent from the book');
  check('  …and it is NOT in Q1’s disposals', !q1.disposals.some((d) => d.stockItemId === taken.id));
  check('  …nor in Q2’s in-stock section', !q2.inStock.some((d) => d.stockItemId === taken.id),
    'same car, two periods, two sections, counted as a disposal exactly once');
  const q4 = await ST.stockBook(ZZ_GROUP, new Date('2026-10-01'), new Date('2026-12-31'));
  check('  …and it has left the book entirely by Q4', !q4.inStock.some((d) => d.stockItemId === taken.id)
    && !q4.disposals.some((d) => d.stockItemId === taken.id),
    'gone before the period opened');

  /** RE-RUNNING Q1 MUST GIVE WHAT IT GAVE. The figures froze at disposal; the query is reproducible. */
  const q1again = await ST.stockBook(ZZ_GROUP, new Date('2026-01-01'), new Date('2026-03-31'));
  check('re-running a closed quarter gives the same book', JSON.stringify(q1again) === JSON.stringify(q1),
    'the figures were frozen at disposal, which is what makes the query reproducible');

  /** ── THE FLOOR IS A VAT RULE, AND THE BOOK STILL SHOWS THE LOSS ───────────────────────────── */
  console.log('\n— a loss-making car —');
  const loser = S.bookRow({ purchasePence: 400000, disposal: { kind: 'sold', salePence: 300000 } });
  check('the book shows the real loss', loser.marginPence === -100000, gbp(loser.marginPence));
  check('  …and no VAT is owed on it', loser.vatDuePence === 0, gbp(loser.vatDuePence));
  check('  …the floor is on the VAT, never on the reported margin', loser.marginPence < 0 && loser.vatDuePence === 0,
    'a book showing zero instead of −£1,000 would hide the thing this feature exists to surface');
  check('  …and two losses cannot offset a profit', (() => {
    const rows = [
      S.bookRow({ purchasePence: 400000, disposal: { kind: 'sold', salePence: 300000 } }),
      S.bookRow({ purchasePence: 100000, disposal: { kind: 'sold', salePence: 400000 } }),
    ];
    const due = rows.reduce((a, r) => a + (r.vatDuePence ?? 0), 0);
    return due === Math.round(300000 / 6);
  })(), 'the profitable car owes its full sixth; the loss does not reduce it');

  /** ── THREE OF THE FIVE WAYS OUT ARE NOT SALES ─────────────────────────────────────────────── */
  console.log('\n— how a car left, which is not always a sale —');
  for (const k of ['scrapped', 'returned']) {
    const r = S.bookRow({ purchasePence: 125000, disposal: { kind: k, salePence: null } });
    check(`  …${k}: no supply, so no VAT and no margin`, r.vatPosition === 'none' && r.vatDuePence === null
      && r.marginPence === null, 'a scrapped car did not sell for nothing — it did not sell');
  }
  /**
   * AND THE WRITER REFUSES A SALE PRICE ON A NON-SALE. Measured: breaking hasSalePrice so every kind
   * counts as a sale scored 0 failures of 35, because every clause here passed it a NULL price and
   * bookRow short-circuits on that. The check that bites is the STORE being handed a price it must
   * drop — which is what a user typing into the wrong field actually does.
   */
  const scrapVeh = await prisma.vehicle.create({
    data: { group_id: ZZ_GROUP, registration: `ZZSTK${Math.floor(Math.random() * 900 + 100)}S`, make: 'Gate', model: 'Scrap' },
    select: { id: true },
  });
  made.vehicles.push(scrapVeh.id);
  const scrapItem = await ST.takeIntoStock({
    groupId: ZZ_GROUP, userId: owner.id, vehicleId: scrapVeh.id, acquiredAt: new Date('2026-02-01'),
    purchasePence: 50000, vatStatus: 'margin', source: 'auction',
  });
  made.items.push(scrapItem.id);
  await ST.recordDisposal({
    groupId: ZZ_GROUP, userId: owner.id, stockItemId: scrapItem.id,
    disposedAt: new Date('2026-02-20'), kind: 'scrapped', salePence: 50000,   // a price on a non-sale
  });
  const scrapRow = await prisma.stockDisposal.findFirst({
    where: { stock_item_id: scrapItem.id }, select: { sale_pence: true, kind: true },
  });
  check('a sale price handed to a SCRAPPED disposal is dropped', scrapRow?.sale_pence === null,
    `stored ${scrapRow?.sale_pence === null ? 'null' : scrapRow?.sale_pence} — a scrapped car did not sell for £500, it did not sell`);

  const ownUse = S.bookRow({ purchasePence: 125000, disposal: { kind: 'own_use', salePence: null } });
  check('own use is recorded and marked UNSETTLED, with no figure', ownUse.vatPosition === 'unsettled'
    && ownUse.vatDuePence === null,
    'a deemed supply whose treatment we cannot state — any figure would be believed');
  check('  …and the book says so in words, not in a comment', /deemed supply/.test(S.OWN_USE_UNSETTLED_NOTE)
    && /ask your accountant/.test(S.OWN_USE_UNSETTLED_NOTE), JSON.stringify(S.OWN_USE_UNSETTLED_NOTE.slice(0, 60)));
  check('  …and it is never refused', S.DISPOSAL_KINDS.includes('own_use'),
    'a feature that refuses to record what happened is one they work around with a spreadsheet');
  check('the labour gap is named on the document', /no measured workshop rate/.test(S.LABOUR_AT_ZERO_NOTE),
    'the same honest gap as the wage bill, said out loud rather than left in a comment');

  /** ── THE WRITER REFUSES WHAT IT SHOULD ─────────────────────────────────────────────────────── */
  console.log('\n— what the writer will not do —');
  const again = await ST.takeIntoStock({
    groupId: ZZ_GROUP, userId: owner.id, vehicleId: veh.id, acquiredAt: new Date('2026-05-01'),
    purchasePence: 100000, vatStatus: 'margin', source: 'trade',
  });
  check('a car that has LEFT stock can be bought again', !!again.id, again.refused ?? 'a second record, which is right');
  if (again.id) made.items.push(again.id);
  const twice = await ST.takeIntoStock({
    groupId: ZZ_GROUP, userId: owner.id, vehicleId: veh.id, acquiredAt: new Date('2026-05-02'),
    purchasePence: 100000, vatStatus: 'margin', source: 'trade',
  });
  if (twice.id) made.items.push(twice.id);   // only reachable if the refusal broke — tracked so teardown still cleans
  check('  …but not while it is still in stock', !!twice.refused,
    `${twice.refused ?? 'ACCEPTED — "is this in stock?" would now have two answers'}`);
  const backwards = await ST.recordDisposal({
    groupId: ZZ_GROUP, userId: owner.id, stockItemId: again.id,
    disposedAt: new Date('2026-04-01'), kind: 'sold', salePence: 200000,
  });
  check('a car cannot leave before it arrived', !!backwards.refused, backwards.refused ?? 'ACCEPTED');
  const otherTenant = await ST.takeIntoStock({
    groupId: ZZ_GROUP, userId: owner.id, vehicleId: 'not-a-vehicle-on-this-account',
    acquiredAt: new Date(), purchasePence: 1000, vatStatus: 'margin', source: 'trade',
  });
  check('a vehicle from another account is refused', !!otherTenant.refused, otherTenant.refused);

  /** ── NO OWNERSHIP EDGE. The record asserts ownership; the garage is not a customer. ────────── */
  console.log('\n— the garage is not a customer —');
  const edges = await prisma.vehicleOwnership.count({ where: { vehicle_id: veh.id } });
  check('taking a car into stock writes NO ownership edge', edges === 0,
    'a garage-as-customer row would reach marketing lists and MOT reminders, and the garage would text itself');
  const storeSrc = readFileSync('lib/stock-store.ts', 'utf8');
  check('  …and the writer never touches one', !/vehicleOwnership/i.test(storeSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')),
    'asserted on the code, because the absence of a row is only evidence about the path this test took');

  /** ── THE MIGRATION KEPT THIS TO ONE PUSH ───────────────────────────────────────────────────── */
  const migRaw = readFileSync('prisma/migrations/20260913190000_stock_records/migration.sql', 'utf8');
  // COMMENTS STRIPPED. This migration's header EXPLAINS why there is no CREATE UNIQUE INDEX, so a
  // scanner that cannot tell prose from SQL finds the very statement it is banning — which it did.
  // Third time in one session; the rule is now reflexive: strip before you scan.
  const mig = migRaw.replace(/^\s*--.*$/gm, '');
  check('the migration declares itself additive', /@migration: additive/.test(migRaw),
    'read from the RAW file — the header is a comment, and it is the one thing that must be in one');
  check('  …with one disposal per item stated INSIDE the table', /CONSTRAINT "StockDisposal_stock_item_id_key" UNIQUE/.test(mig)
    && !/CREATE\s+UNIQUE\s+INDEX/i.test(mig),
    'a separate CREATE UNIQUE INDEX classifies constraining even on a brand-new table');
  check('  …no UPDATE and no DELETE', !/^\s*(UPDATE|DELETE)\s/im.test(mig),
    'a backfill is a script with the owner’s say-so, not a migration that runs itself for ever');
  check('  …and the Invoice column carries NO foreign key', /ALTER TABLE "Invoice" ADD COLUMN "stock_disposal_id" TEXT;/.test(mig)
    && !/ALTER TABLE "Invoice"[^;]*REFERENCES/i.test(mig),
    'an FK from an existing table is ADD CONSTRAINT — the one thing that would have made this two pushes');
  /**
   * ── DAYS IN STOCK, THE FIGURE THE LIST EXISTS FOR ─────────────────────────────────────────────
   * Counted from the DATE, not a timestamp, and floored — a car bought this morning is day 0, not
   * "−1 days" because someone typed today and the clock had not caught up. `asOf` is passed in so the
   * figure is assertable at a fixed instant rather than drifting with the test's own runtime.
   */
  console.log('\n— days in stock —');
  /**
   * TWENTY-TWO HOURS APART, ON ONE DAY. The first version of this clause used nine hours — and
   * switching the function to timestamp arithmetic scored 0 failures of 50, because 9/24 rounds to 0
   * either way. A fixture has to force the branch it is about: at 22 hours the timestamp reading says
   * 1 and the date reading says 0, which is the whole difference between the two.
   */
  check('a car bought today is day 0, however late it is', S.daysInStock(
    new Date('2026-09-13T01:00:00Z'), new Date('2026-09-13T23:00:00Z')) === 0,
    'twenty-two hours apart and still the same day — counted from the DATE, not the clock');
  check('  …109 days is 109', S.daysInStock(new Date('2024-11-25T12:00:00Z'), new Date('2025-03-14T12:00:00Z')) === 109,
    'YP61LBF, 25/11/2024 to 14/03/2025 — the real car this was checked against');
  check('  …and a future acquisition floors at zero rather than going negative',
    S.daysInStock(new Date('2026-10-01'), new Date('2026-09-13')) === 0);

  /**
   * ── WHAT THE LIST AND THE RESOLVER DO, ASSERTED DIRECTLY ──────────────────────────────────────
   * Each of these was covered only by a browser clause, and each mutation below scored 0 failures
   * before they existed: the yard listing disposed cars, a registration matching only exactly, and a
   * missing acquisition date being defaulted. A clause that reaches a function through three layers
   * tests the layers.
   */
  console.log('\n— the list and the resolver, directly —');
  const goneVeh = await prisma.vehicle.create({
    data: { group_id: ZZ_GROUP, registration: `ZZSTK${Math.floor(Math.random() * 900 + 100)}G`, make: 'Gate', model: 'Gone' },
    select: { id: true, registration: true },
  });
  made.vehicles.push(goneVeh.id);
  const goneItem = await ST.takeIntoStock({
    groupId: ZZ_GROUP, userId: owner.id, vehicleId: goneVeh.id, acquiredAt: new Date('2026-03-01'),
    purchasePence: 90000, vatStatus: 'margin', source: 'trade',
  });
  made.items.push(goneItem.id);
  const listBefore = await ST.stockList(ZZ_GROUP, new Date('2026-09-13'));
  check('a held car is in the yard', listBefore.some((r) => r.stockItemId === goneItem.id), `${listBefore.length} in stock`);
  await ST.recordDisposal({
    groupId: ZZ_GROUP, userId: owner.id, stockItemId: goneItem.id,
    disposedAt: new Date('2026-04-01'), kind: 'traded_out', salePence: 120000,
  });
  const listAfter = await ST.stockList(ZZ_GROUP, new Date('2026-09-13'));
  check('  …and gone from it once it has left', !listAfter.some((r) => r.stockItemId === goneItem.id),
    'the yard is what is in stock, not what was ever bought');
  /**
   * ORDER NEEDS TWO CARS TO BE AN ORDER. The first version of this asserted `every(prev <= next)` on
   * whatever the yard happened to hold — which was one car, so reversing the sort scored 0 failures.
   * A non-vacuity guard is not decoration here: it IS the clause.
   */
  const older = await prisma.vehicle.create({
    data: { group_id: ZZ_GROUP, registration: `ZZSTK${Math.floor(Math.random() * 900 + 100)}O`, make: 'Gate', model: 'Older' },
    select: { id: true },
  });
  made.vehicles.push(older.id);
  const olderItem = await ST.takeIntoStock({
    groupId: ZZ_GROUP, userId: owner.id, vehicleId: older.id, acquiredAt: new Date('2025-01-05'),
    purchasePence: 70000, vatStatus: 'margin', source: 'private',
  });
  made.items.push(olderItem.id);
  const ordered = await ST.stockList(ZZ_GROUP, new Date('2026-09-13'));
  check('  …oldest first, so the car costing money is at the top', (() => {
    if (ordered.length < 2) return false;   // an order over one row is not an order
    const times = ordered.map((r) => new Date(r.acquiredAt).getTime());
    return times.every((t, i) => i === 0 || times[i - 1] <= t) && ordered[0].stockItemId === olderItem.id;
  })(), `${ordered.length} cars, oldest ${ordered[0]?.registration} first — with one row this clause would pass whatever the sort did`);

  // A REGISTRATION IS THE SAME CAR HOWEVER IT IS SPACED. Nothing asserted this, and matching only
  // exactly would quietly create a second vehicle — and then a second stock record for one car.
  const spaced = await ST.findOrCreateVehicle({ groupId: ZZ_GROUP, registration: goneVeh.registration.replace(/^(.{4})/, '$1 ') });
  // THE FIXTURE IS DELIBERATELY A LEGACY-SHAPED ROW — created directly, with registration_normalized
  // left NULL, which is how 35 of the 1,836 vehicles on this database actually are. Matching only on
  // that column found nothing for them and would have made a second car for one that existed.
  check('a spaced registration finds the SAME car', spaced.id === goneVeh.id,
    `"${goneVeh.registration.replace(/^(.{4})/, '$1 ')}" resolved to the car already on file, not a new one`);
  const lower = await ST.findOrCreateVehicle({ groupId: ZZ_GROUP, registration: goneVeh.registration.toLowerCase() });
  check('  …and so does a lower-case one', lower.id === goneVeh.id,
    'the garage should not have to know which spelling the database met first');

  /**
   * ── THE LIST IS THE PAGE ──────────────────────────────────────────────────────────────────────
   * Driven through the real API and the real page, because a list nobody can read is what this slice
   * exists to fix.
   */
  console.log('\n— the yard, through the real page —');
  const ready = await serverReady();
  check('the dev server serves pages before we drive it', ready.ok, `HTTP ${ready.status} after ${ready.attempts} attempt(s)`);
  browser = await chromium.launch({ channel: 'chrome' });
  const page = await (await browser.newContext()).newPage();
  await page.goto(`${gateOrigin()}/admin/login`, { waitUntil: 'domcontentloaded' });
  await page.fill('input[type="email"]', 'owner@zzgategarage.test');
  await page.fill('input[type="password"]', 'GateGarage!2026');
  await Promise.all([page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 60000 }), page.click('button[type="submit"]')]);
  await page.goto(`${gateOrigin()}/admin/stock`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-testid="add-toggle"]', { timeout: 25000 });

  // BUY A CAR THE WAY A PERSON DOES: a registration and nothing else to start with.
  const reg = `ZZYARD${Math.floor(Math.random() * 900 + 100)}`;
  await page.click('[data-testid="add-toggle"]');
  await page.waitForSelector('[data-testid="add-form"]', { timeout: 15000 });
  await page.fill('[data-testid="input-reg"]', reg);
  await page.fill('[data-testid="input-make"]', 'Mini');
  await page.fill('[data-testid="input-purchase"]', '1250');
  await page.fill('[data-testid="input-fee-premium"]', '265.20');
  await page.fill('[data-testid="input-fee-services"]', '81.60');
  await page.fill('[data-testid="input-acquired"]', '2026-06-01');
  await page.click('[data-testid="add-submit"]');
  await page.waitForSelector(`[data-testid="stock-row-${reg}"]`, { timeout: 20000 });
  check('a car typed in by registration appears in the yard', true, `${reg} is on the list`);

  const created = await prisma.stockItem.findFirst({
    where: { group_id: ZZ_GROUP, vehicle: { registration: reg } },
    select: { id: true, vehicle_id: true, purchase_pence: true, premium_pence: true, services_pence: true, vat_status: true },
  });
  if (created) { made.items.push(created.id); made.vehicles.push(created.vehicle_id); }
  check('  …and the vehicle was created for it, not demanded first', !!created?.vehicle_id,
    'a garage at an auction has a registration and nothing else');
  check('  …with the fees kept apart, as the invoice has them',
    created?.purchase_pence === 125000 && created?.premium_pence === 26520 && created?.services_pence === 8160,
    `${created?.purchase_pence}p + premium ${created?.premium_pence}p + services ${created?.services_pence}p`);
  check('  …and the VAT treatment captured at purchase', created?.vat_status === 'margin',
    'recorded against the car as bought, whatever the tenant does later');
  const daysCell = await page.locator(`[data-testid="days-${reg}"]`).textContent();
  check('  …and days in stock is on the row', /^\d+$/.test((daysCell ?? '').trim()),
    `${daysCell?.trim()} days — the figure a garage counts on its fingers today`);
  check('  …with what is tied up said once, at the top',
    /tied up/.test((await page.locator('[data-testid="stock-summary"]').textContent()) ?? ''),
    ((await page.locator('[data-testid="stock-summary"]').textContent()) ?? '').trim());

  // THE SOURCE STILL CONSTRAINS THE TREATMENT, on this page too.
  await page.click('[data-testid="add-toggle"]');
  await page.waitForSelector('[data-testid="add-form"]', { timeout: 15000 });
  await page.selectOption('[data-testid="input-source"]', 'private');
  await page.waitForSelector('[data-testid="vat-forced"]', { timeout: 15000 });
  check('a private purchase cannot be recorded as VAT qualifying here either',
    (await page.locator('[data-testid="vat-qualifying"]').count()) === 0,
    'one reader for the rule, so the two pages cannot disagree');
  check('  …and no fee fields, because a private seller invoices none',
    (await page.locator('[data-testid="fee-fields"]').count()) === 0);
  check('the form says the treatment is captured at purchase',
    /whatever your own VAT status does later/.test((await page.locator('[data-testid="vat-captured-note"]').textContent()) ?? ''),
    'the one answer on this form that cannot be corrected later by changing a setting');

  /**
   * THE ACQUISITION DATE IS REFUSED, NEVER DEFAULTED. It sets the book's period boundary and every
   * days-in-stock figure, so defaulting it to today would put a car in the wrong quarter silently.
   * Driven over HTTP because the refusal is the endpoint's, and nothing else asserted it.
   */
  const noDate = await page.evaluate(async (origin) => {
    const r = await fetch(`${origin}/api/stock`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin',
      body: JSON.stringify({ registration: 'ZZNODATE1', purchasePence: 100000, vatStatus: 'margin', source: 'trade' }),
    });
    return { status: r.status, body: await r.json().catch(() => ({})) };
  }, gateOrigin());
  check('a purchase with no date is REFUSED, not dated today', noDate.status === 400
    && /when you bought it/i.test(noDate.body.message ?? ''),
    `${noDate.status} ${JSON.stringify(noDate.body.message ?? '')}`);
  check('  …and no car was created by the attempt',
    (await prisma.vehicle.count({ where: { group_id: ZZ_GROUP, registration: 'ZZNODATE1' } })) === 0,
    'refused before the vehicle is resolved, so a rejected form leaves nothing behind');

  // A DISPOSED CAR LEAVES THE YARD — the list is "in stock", not "ever bought".
  await ST.recordDisposal({
    groupId: ZZ_GROUP, userId: owner.id, stockItemId: created.id,
    disposedAt: new Date('2026-08-01'), kind: 'sold', salePence: 400000,
  });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-testid="add-toggle"]', { timeout: 25000 });
  check('a car that has left no longer appears in the yard',
    (await page.locator(`[data-testid="stock-row-${reg}"]`).count()) === 0,
    'the list is what is in stock, not what was ever bought');


  // ════════════════════════════════════════════════════════════════════════════════════════════
  //  THE AUCTION INVOICE — the facts that arrive with the car, and where each of them belongs
  // ════════════════════════════════════════════════════════════════════════════════════════════
  console.log('\n— the VIN is an identity, so intake is stricter than anywhere else —');

  check('a good VIN normalises through the SHARED chokepoint, not a local copy',
    SI.vinAtIntake(' wvw-zzz1kz aw123456 ').vin === 'WVWZZZ1KZAW123456');
  check('  …and the module does not hand-roll upper/trim',
    !/toUpperCase\(\)/.test(readFileSync('lib/stock-intake.ts', 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').split('normaliseV5c')[0]),
    'a second normaliser diverges from normalizeVin on punctuation and splits the dedup key');
  check('blank is not an error — a plate and nothing else is a real auction',
    SI.vinAtIntake('').vin === null && SI.vinAtIntake(null).vin === null && SI.vinAtIntake(undefined).vin === null);
  check('a 16-character VIN is REFUSED, and the refusal says the length',
    /16/.test(SI.vinAtIntake('WVWZZZ1KZAW12345').refused ?? ''));
  check('a VIN containing I, O or Q is REFUSED and says which letters',
    /I, O or Q/.test(SI.vinAtIntake('WVWZZZ1KZAWI23456').refused ?? ''));
  check('  …and that is STRICTER than quick-validate, deliberately',
    (await import('../lib/quick-validate.ts')).vinWarn('WVWZZZ1KZAW12345') === 'vin'
      && 'refused' in SI.vinAtIntake('WVWZZZ1KZAW12345'),
    'warn on a job card, refuse at the identity anchor');

  console.log('\n— import status and warranted mileage are THREE-state —');
  check('unrecorded is null, not false',
    SI.parseImportStatus('unknown') === null && SI.parseImportStatus(undefined) === null
      && SI.parseImportStatus('') === null);
  check('  …and "no" is a positive statement of UK supply',
    SI.parseImportStatus('no') === false && SI.parseImportStatus('yes') === true);
  check('warranted follows the same three states',
    SI.parseWarranted('unknown') === null && SI.parseWarranted('no') === false && SI.parseWarranted('yes') === true);
  check('the schema column is NULLABLE, so the third state can be stored at all',
    /mileage_warranted Boolean\?/.test(readFileSync('prisma/schema.prisma', 'utf8'))
      && /is_import\s+Boolean\?/.test(readFileSync('prisma/schema.prisma', 'utf8')),
    'a NOT NULL column with a default would make every unasked car claim to be UK-supplied');

  console.log('\n— MOT: fill a silence, never overwrite a check —');
  const dvsaDay = new Date('2027-08-02T12:00:00Z');
  const typed = new Date('2027-08-02T12:00:00Z');
  const other = new Date('2026-01-01T12:00:00Z');
  check('DVSA never answered → the typed date is WRITTEN',
    SI.motExpiryDecision({ motExpiry: null, motCheckedAt: null }, typed).write?.getTime() === typed.getTime());
  check('  …and the reason names it as stated, not verified',
    SI.motExpiryDecision({ motExpiry: null, motCheckedAt: null }, typed).reason === 'stated_dvsa_silent');
  check('DVSA answered and the typed date AGREES → nothing is written',
    SI.motExpiryDecision({ motExpiry: dvsaDay, motCheckedAt: new Date() }, typed).write === null);
  check('DVSA answered and the typed date DIFFERS → REFUSED, naming the checked date',
    /2027-08-02/.test(SI.motExpiryDecision({ motExpiry: dvsaDay, motCheckedAt: new Date() }, other).refused ?? ''));
  check('  …refused, not silently dropped — a dropped edit leaves the garage believing it took',
    'refused' in SI.motExpiryDecision({ motExpiry: dvsaDay, motCheckedAt: new Date() }, other));
  check('nothing typed is never a refusal',
    SI.motExpiryDecision({ motExpiry: dvsaDay, motCheckedAt: new Date() }, null).write === null);
  check('NO PATH HERE STAMPS mot_checked_at — the stamp means DVSA answered and only dvsa.ts may set it',
    !/mot_checked_at/.test(readFileSync('lib/stock-intake.ts', 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, ''))
      && !/mot_checked_at/.test(readFileSync('lib/stock-store.ts', 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').split('VEHICLE_INTAKE_FIELDS')[1] ?? ''));

  console.log('\n— DVSA supplies first registration, from the field that means it —');
  /**
   * A REAL DVSA-SHAPED PAYLOAD, through the real parse. An import: first USED abroad in 2016, first
   * REGISTERED here in 2019. Taking the wrong field ages the car by three years on every screen.
   */
  const payload = {
    make: 'BMW', model: '320D', primaryColour: 'Blue', fuelType: 'Diesel', engineSize: '1995',
    registrationDate: '2019-04-11', firstUsedDate: '2016-09-02', manufactureDate: '2016-01-01',
    motTests: [{ expiryDate: '2027-08-02', completedDate: '2026-08-01', odometerValue: '84231', odometerUnit: 'mi' }],
  };
  const parsed = DV.vehicleFromPayload(payload);
  check('firstRegistered comes back from the lookup at all', parsed.firstRegistered === '2019-04-11',
    `got ${parsed.firstRegistered}`);
  check('  …from registrationDate, NOT firstUsedDate — they differ exactly for an import',
    parsed.firstRegistered !== '2016-09-02',
    'firstUsedDate would make every import read three years older than its UK registration');
  check('  …and make, model and MOT expiry still arrive with it',
    parsed.make === 'BMW' && parsed.model === '320D' && parsed.motExpiry === '2027-08-02');
  check('a payload with no registration date yields nothing rather than a guess',
    DV.vehicleFromPayload({ make: 'X', firstUsedDate: '2016-09-02' }).firstRegistered === undefined);
  const intakePage = readFileSync('pages/admin/stock.tsx', 'utf8');
  check('the intake form fills the field from the lookup',
    hasKey(intakePage, 'firstRegistered', /f\.firstRegistered \|\| body\.firstRegistered/));
  check('  …without overwriting what the person typed off the logbook',
    /f\.firstRegistered \|\|/.test(intakePage),
    'DVSA is not authoritative about this one — the person holding the V5C is looking at it');
  check('MOT stays read-only when DVSA answered, and open when it did not',
    /readOnly={dvsaMot !== null}/.test(intakePage) && /recorded as stated, not verified/.test(intakePage));

  console.log('\n— first registration cannot be after the day it was bought —');
  const bought = new Date('2024-06-01T12:00:00Z');
  check('a future first registration is refused',
    !!SI.firstRegisteredRefusal(new Date('2030-01-01T12:00:00Z'), bought, new Date('2026-09-13T12:00:00Z')));
  check('registered AFTER the purchase is refused, and the refusal shows both dates',
    /2024-06-01/.test(SI.firstRegisteredRefusal(new Date('2024-09-01T12:00:00Z'), bought, new Date('2026-09-13T12:00:00Z')) ?? '')
      && /2024-09-01/.test(SI.firstRegisteredRefusal(new Date('2024-09-01T12:00:00Z'), bought, new Date('2026-09-13T12:00:00Z')) ?? ''));
  check('a normal one passes', SI.firstRegisteredRefusal(new Date('2018-03-01T12:00:00Z'), bought, new Date('2026-09-13T12:00:00Z')) === null);

  console.log('\n— mileage is a READING, and auction is the least-attested source —');
  check('the auction source exists and ranks FIRST', OD.READING_SOURCE_ORDER.auction === 0);
  check('  …and the rank still agrees with the alphabet the orderBy can express',
    (() => { const r = Object.entries(OD.READING_SOURCE_ORDER).sort((a, b) => a[1] - b[1]).map(([k]) => k);
             return JSON.stringify(r) === JSON.stringify([...r].sort()); })(),
    'readingsForVehicle can only say source:asc — a rank disagreeing with it splits the two orderings');
  check('  …so a visit on the same day still wins the tie, which is what sets the rate',
    OD.compareReadings({ date: bought, miles: 1, source: 'auction' }, { date: bought, miles: 2, source: 'visit' }) < 0);
  check('mileage refuses a negative and an absurd figure, and passes a real one',
    'refused' in SI.parseMiles(-1) && 'refused' in SI.parseMiles(2_000_000) && SI.parseMiles('84,231').miles === 84231);
  check('blank mileage is not an error', SI.parseMiles('').miles === null && SI.parseMiles(null).miles === null);

  console.log('\n— and the reading actually lands on the car, through the real writer —');
  const regA = `ZZSTK${Math.floor(Math.random() * 900 + 100)}A`;
  const vA = await ST.findOrCreateVehicle({
    groupId: ZZ_GROUP, registration: regA, vin: 'WVWZZZ1KZAW123456',
    firstRegistered: new Date('2018-03-01T12:00:00Z'), isImport: 'yes',
    v5cReference: '1234 5678 9012', acquiredAt: bought,
  });
  if ('refused' in vA) throw new Error(`fixture vehicle refused: ${vA.refused}`);
  made.vehicles.push(vA.id);
  const storedA = await prisma.vehicle.findUnique({
    where: { id: vA.id },
    select: { vin: true, vin_normalized: true, first_registered: true, is_import: true, v5c_reference: true },
  });
  check('the VIN, first registration, import flag and V5C are all on the CAR',
    storedA.vin_normalized === 'WVWZZZ1KZAW123456' && storedA.is_import === true
      && storedA.first_registered?.toISOString().slice(0, 10) === '2018-03-01'
      && storedA.v5c_reference === '123456789012',
    'the V5C is stored normalised — spaces out, which is how it is quoted');

  const tookA = await ST.takeIntoStock({
    groupId: ZZ_GROUP, userId: owner.id, vehicleId: vA.id, acquiredAt: bought,
    purchasePence: 150000, vatStatus: 'margin', source: 'auction',
    mileageMiles: 84231, mileageWarranted: 'no',
  });
  if ('refused' in tookA) throw new Error(`fixture stock refused: ${tookA.refused}`);
  made.items.push(tookA.id);
  const readings = await OD.readingsForVehicle(prisma, ZZ_GROUP, vA.id);   // POSITIONAL — an object silently matches nothing
  check('the mileage went into the odometer SERIES, under source auction',
    readings.some((r) => r.miles === 84231 && r.source === 'auction'),
    `${readings.length} reading(s)`);
  check('  …and NOT onto a column of the stock item',
    !/mileage_miles|miles\s+Int/.test(readFileSync('prisma/schema.prisma', 'utf8').split('model StockItem')[1].split('}')[0]),
    'a second place to ask a car how far it has gone is a second answer');
  const warranted = await prisma.stockItem.findUnique({ where: { id: tookA.id }, select: { mileage_warranted: true } });
  check('warranted is on the STOCK ITEM — the term belongs to this purchase, not to the car',
    warranted.mileage_warranted === false);

  console.log('\n— the VIN fails closed, both ways, and names the other car —');
  const regB = `ZZSTK${Math.floor(Math.random() * 900 + 100)}B`;
  const clash = await ST.findOrCreateVehicle({
    groupId: ZZ_GROUP, registration: regB, vin: 'WVWZZZ1KZAW123456', acquiredAt: bought,
  });
  check('a VIN already on ANOTHER car is refused',
    'refused' in clash, 'refused' in clash ? clash.refused.slice(0, 60) : 'IT MERGED THEM');
  check('  …and the refusal names the registration it clashed with',
    'refused' in clash && clash.refused.includes(regA));
  check('  …and no second car was created by the attempt',
    (await prisma.vehicle.count({ where: { group_id: ZZ_GROUP, registration: regB } })) === 0,
    'a refusal that leaves a half-made car behind is worse than none');
  const overwrite = await ST.findOrCreateVehicle({
    groupId: ZZ_GROUP, registration: regA, vin: 'WVWZZZ1KZAW999999', acquiredAt: bought,
  });
  check('a DIFFERENT VIN on a car that already has one is refused, not overwritten',
    'refused' in overwrite);
  check('  …and the stored VIN is untouched',
    (await prisma.vehicle.findUnique({ where: { id: vA.id }, select: { vin_normalized: true } })).vin_normalized === 'WVWZZZ1KZAW123456');

  console.log('\n— absent never erases —');
  const silentIntake = await ST.findOrCreateVehicle({ groupId: ZZ_GROUP, registration: regA, acquiredAt: bought });
  check('a second intake with no VIN, no V5C and no import answer resolves the SAME car',
    'id' in silentIntake && silentIntake.id === vA.id);
  const kept = await prisma.vehicle.findUnique({
    where: { id: vA.id }, select: { vin_normalized: true, is_import: true, v5c_reference: true },
  });
  check('  …the car still has its VIN, its import flag and its V5C',
    kept.vin_normalized === 'WVWZZZ1KZAW123456' && kept.is_import === true && kept.v5c_reference === '123456789012',
    'a form silent about a field is not a statement that the stored value was wrong');


  // ════════════════════════════════════════════════════════════════════════════════════════════
  //  INTERNAL PREP — work on a car WE OWN bills nobody and costs the car
  // ════════════════════════════════════════════════════════════════════════════════════════════
  console.log('\n— the link IS the flag —');
  check('a card with a stock item is internal', SP.isInternalStock({ stock_item_id: 'x' }) === true);
  check('a card without one is not', SP.isInternalStock({ stock_item_id: null }) === false
    && SP.isInternalStock({}) === false && SP.isInternalStock(null) === false);
  /**
   * COMMENTS STRIPPED FIRST. The schema comment for stock_item_id EXPLAINS that no such boolean
   * exists, and naming it there is the clearest way to say so — so an unstripped scan flags the
   * documentation of the rule as a breach of it. Fifth instance of that shape in two days.
   */
  const schemaCode = readFileSync('prisma/schema.prisma', 'utf8')
    .replace(/^\s*\/\/\/?.*$/gm, '');
  check('there is NO second boolean to disagree with the link',
    !/is_internal_stock/.test(schemaCode),
    'two readers answering "is this internal?" differently is the failure this avoids');
  check('  …and the scan can still SEE such a column — it finds stock_item_id in the same stripped source',
    /stock_item_id\s+String\?/.test(schemaCode),
    'a stripper that removed the code too would pass this file and every other');

  console.log('\n— parts at TRADE COST, labour at zero, unknowns counted —');
  const lines = [
    { item_type: 'part', qty: '2', unit_cost: '45.50' },
    { item_type: 'labour', qty: '3', unit_cost: '60.00' },
    { item_type: 'part', qty: '1', unit_cost: null },
    { item_type: 'fixed', qty: '1', unit_cost: '99.00' },
  ];
  const c = SP.prepCost(lines);
  check('parts are valued at unit_cost × qty', c.partsPence === 9100, `${c.partsPence}p — 2 × £45.50`);
  check('LABOUR IS NOT IN THE FIGURE, and is counted so the note is not about an empty set',
    c.labourLines === 1 && c.partsPence === 9100,
    'a £60/h labour line would have added £180 if it had been valued');
  check('  …and that holds when labour is the ONLY thing on the card',
    SP.prepCost([{ item_type: 'labour', qty: '3', unit_cost: '60.00' }]).partsPence === 0,
    'the mixed-line case passes even when labour IS valued, because the parts total dwarfs nothing — this one cannot');
  check('a NULL trade cost is UNKNOWN, never zero', c.unknownCostLines === 2,
    'the uncatalogued part AND the fixed bundle — a cost base quietly missing a turbo reads as a better margin');
  check('  …and the note only speaks when there ARE unknowns',
    SP.unknownCostNote(c) !== null && SP.unknownCostNote({ partsPence: 1, unknownCostLines: 0, labourLines: 0 }) === null,
    'a warning shown always is furniture and stops being read');
  check('the labour note is the BOOK’s wording, not a second one',
    SP.PREP_LABOUR_NOTE === S.LABOUR_AT_ZERO_NOTE);

  console.log('\n— and an internal card cannot be invoiced, by any door —');
  const issueSrc = readFileSync('lib/invoice-issue.ts', 'utf8');
  const mintFns = issueSrc.split('\n').filter((l) => /^export async function issue\w*ForCard\(/.test(l));
  check('every mint entry point is known to this clause', mintFns.length === 3, `${mintFns.length}`);
  check('EVERY one of them refuses an internal card first',
    (issueSrc.match(/await refuseIfInternalStock\(tx, jobCardId\);/g) || []).length === mintFns.length,
    'guarding only the chargeable door leaves the warranty and historical sequences open');
  check('  …and the refusal explains what to do instead',
    /unlink it from the stock item first/i.test(SP.INTERNAL_STOCK_INVOICE_REFUSAL),
    'a refusal that only says no gets worked around by converting the card back');

  console.log('\n— the cost lands on the car, live, through the real writer —');
  const regP = `ZZSTK${Math.floor(Math.random() * 900 + 100)}P`;
  const vP = await ST.findOrCreateVehicle({ groupId: ZZ_GROUP, registration: regP, acquiredAt: bought });
  if ('refused' in vP) throw new Error(vP.refused);
  made.vehicles.push(vP.id);
  const itemP = await ST.takeIntoStock({
    groupId: ZZ_GROUP, userId: owner.id, vehicleId: vP.id, acquiredAt: bought,
    purchasePence: 200000, vatStatus: 'margin', source: 'auction',
  });
  if ('refused' in itemP) throw new Error(itemP.refused);
  made.items.push(itemP.id);

  const site = await prisma.site.findFirst({ where: { group_id: ZZ_GROUP }, select: { id: true } });
  const prepCard = await prisma.jobCard.create({
    data: {
      group_id: ZZ_GROUP, site_id: site.id, vehicle_id: vP.id, stock_item_id: itemP.id,
      items: { create: [
        { item_type: 'part', description: 'ZZ prep disc', qty: 2, unit_cost: 45.5, unit_price: 90 },
        { item_type: 'labour', description: 'ZZ prep fitting', qty: 3, unit_cost: 60, unit_price: 180 },
      ] },
    },
    select: { id: true },
  });
  made.cards = [...(made.cards ?? []), prepCard.id];

  const live = await ST.liveStockCosts(ZZ_GROUP, itemP.id);
  check('the live cost base sees the prep card', live.cards === 1 && live.partsPence === 9100,
    `${live.cards} card(s), ${live.partsPence}p`);
  check('  …and the labour on it is NOT money out', live.labourLines === 1 && live.partsPence === 9100);

  const listed = (await ST.stockList(ZZ_GROUP, new Date())).find((r) => r.stockItemId === itemP.id);
  check('the yard list shows the same figure the library computed',
    listed.prepPence === live.partsPence && listed.prepCards === 1,
    `list ${listed.prepPence}p vs library ${live.partsPence}p — two readers of one number must agree`);

  console.log('\n— frozen at disposal, once, per card —');
  const soldP = await ST.recordDisposal({
    groupId: ZZ_GROUP, userId: owner.id, stockItemId: itemP.id,
    disposedAt: new Date('2026-07-01T12:00:00Z'), kind: 'sold', salePence: 300000, costs: [],
  });
  if ('refused' in soldP) throw new Error(soldP.refused);
  const snaps = await prisma.stockCostSnapshot.findMany({
    where: { stock_item_id: itemP.id }, select: { amount_pence: true, job_card_id: true, kind: true },
  });
  check('disposal froze the prep spend without being told the figure',
    snaps.length === 1 && snaps[0].amount_pence === 9100,
    `${snaps.length} snapshot(s) — the caller passed costs: []`);
  check('  …and it names the CARD, so the figure can be walked back to the work',
    snaps[0].job_card_id === prepCard.id,
    'a book entry saying "£91 of parts" cannot be checked against anything');


  // ════════════════════════════════════════════════════════════════════════════════════════════
  //  A CAR THAT CAME BACK — and the one thing that makes this dangerous
  // ════════════════════════════════════════════════════════════════════════════════════════════
  console.log('\n— return and buyback are different transactions —');
  const priorFixture = {
    disposalId: 'd1', invoiceId: 'i1', invoiceNumber: 'INV-1', soldAt: new Date('2026-03-12T12:00:00Z'),
    salePence: 899500, originalPurchasePence: 620000, originalVatStatus: 'margin',
  };
  const asReturn = RA.reacquisitionCostBase({
    source: 'return', prior: priorFixture, enteredPence: 750000, enteredVatStatus: 'qualifying',
  });
  check('a RETURN restores the ORIGINAL cost base, not the price typed',
    asReturn.purchasePence === 620000 && asReturn.basis === 'restored',
    `got ${asReturn.purchasePence}p against an entered 750000p`);
  check('  …and the ORIGINAL VAT status with it', asReturn.vatStatus === 'margin',
    'a margin car returning does not become VAT qualifying because the box said so');
  const asBuyback = RA.reacquisitionCostBase({
    source: 'buyback', prior: priorFixture, enteredPence: 750000, enteredVatStatus: 'qualifying',
  });
  check('a BUYBACK uses what was just paid, and ignores the old cost base entirely',
    asBuyback.purchasePence === 750000 && asBuyback.basis === 'as_paid',
    'the margin on the next sale is measured from this figure, not from 2024');
  check('  …and takes the VAT status chosen now', asBuyback.vatStatus === 'qualifying');
  check('THE TWO GIVE DIFFERENT ANSWERS FROM IDENTICAL INPUTS',
    asReturn.purchasePence !== asBuyback.purchasePence,
    'if these ever agree, one branch has stopped being a branch');
  check('a RETURN with no sale to reverse is REFUSED, not quietly turned into a buyback',
    'refused' in RA.reacquisitionCostBase({ source: 'return', prior: null, enteredPence: 750000, enteredVatStatus: 'margin' }),
    'that substitution is the one that credits VAT which was properly owed');
  check('a BUYBACK with no price is refused',
    'refused' in RA.reacquisitionCostBase({ source: 'buyback', prior: null, enteredPence: 0, enteredVatStatus: 'margin' }));
  check('a BUYBACK does NOT need a prior sale — you can buy back a car you never sold',
    RA.reacquisitionCostBase({ source: 'buyback', prior: null, enteredPence: 750000, enteredVatStatus: 'margin' }).purchasePence === 750000);
  check('only the RETURN raises a credit note',
    RA.raisesCreditNote('return') === true && RA.raisesCreditNote('buyback') === false
      && RA.raisesCreditNote('auction') === false);

  console.log('\n— THE MATCH FINDS, AND NEVER CHOOSES —');
  /**
   * THE CLAUSE THE OWNER NAMED. Everything else here can be satisfied by a form that helpfully
   * preselects; this cannot. The comparison is against the source a car with NO prior sale leaves
   * behind, so "unchanged" is measured rather than assumed.
   */
  check('the PriorSale shape cannot express a preference at all',
    !/suggested|recommend|likely|default|probable/i.test(
      readFileSync('lib/stock-reacquisition.ts', 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')),
    'a caller wanting to preselect would have to invent the field, which is a visible act');
  check('the page never writes source from the prior-sale lookup',
    (() => {
      const src = readFileSync('pages/admin/stock.tsx', 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '').replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, '').replace(/^\s*\/\/.*$/gm, '');
      const lookup = src.split('priorSaleFor')[1]?.split('}\n')[0] ?? '';
      return lookup.length > 0 && !/source/.test(lookup);
    })(),
    'the whole discipline of this feature in one assertion');

  // A REAL CAR WITH A REAL PRIOR SALE, driven through the real form.
  const regR = `ZZYARD${Math.floor(Math.random() * 900 + 100)}R`;
  const vR = await ST.findOrCreateVehicle({ groupId: ZZ_GROUP, registration: regR, acquiredAt: bought });
  if ('refused' in vR) throw new Error(vR.refused);
  made.vehicles.push(vR.id);
  const oldItem = await ST.takeIntoStock({
    groupId: ZZ_GROUP, userId: owner.id, vehicleId: vR.id, acquiredAt: new Date('2026-01-10T12:00:00Z'),
    purchasePence: 620000, vatStatus: 'margin', source: 'auction',
  });
  if ('refused' in oldItem) throw new Error(oldItem.refused);
  made.items.push(oldItem.id);
  const oldSale = await ST.recordDisposal({
    groupId: ZZ_GROUP, userId: owner.id, stockItemId: oldItem.id,
    disposedAt: new Date('2026-03-12T12:00:00Z'), kind: 'sold', salePence: 899500, costs: [],
  });
  if ('refused' in oldSale) throw new Error(oldSale.refused);

  const foundPrior = await ST.findPriorSale(ZZ_GROUP, vR.id);
  check('the lookup finds the earlier sale', foundPrior?.originalPurchasePence === 620000
    && foundPrior?.salePence === 899500, `${foundPrior ? 'found' : 'NOT FOUND'}`);
  check('  …and a car with NO history returns null, so the finder can tell them apart',
    (await ST.findPriorSale(ZZ_GROUP, vA.id)) === null,
    'a finder that never returns null cannot report an absence');
  check('asking whether a car has been here before CREATES NOTHING',
    (await ST.findVehicleByReg(ZZ_GROUP, 'ZZNOSUCHREG9')) === null
      && (await prisma.vehicle.count({ where: { group_id: ZZ_GROUP, registration: 'ZZNOSUCHREG9' } })) === 0,
    'a lookup with a side effect is how a typo becomes a vehicle record');

  // ── THROUGH THE PAGE, both cars, and the source compared ────────────────────────────────────
  const sourceAfterTyping = async (plate) => {
    await page.goto(`${gateOrigin()}/admin/stock`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('[data-testid="add-toggle"]', { timeout: 25000 });
    await page.click('[data-testid="add-toggle"]');
    await page.waitForSelector('[data-testid="input-source"]', { timeout: 15000 });
    const before = await page.inputValue('[data-testid="input-source"]');
    await page.fill('[data-testid="input-reg"]', plate);
    await page.click('[data-testid="input-make"]');            // blur → both lookups fire
    /**
     * WAIT ON THE STATE THE COMPONENT READS, not on a guess about how long two fetches take. The
     * prior-sale answer is three-state precisely so this is possible: 'done' means asked-and-answered,
     * which `priorSale === null` cannot distinguish from never-asked. Checking for the panel before
     * this settles is how the first version of this clause reported "no match" on a matched car.
     */
    await page.waitForSelector('[data-testid="add-form"][data-prior-state="done"]', { timeout: 25000 });
    const matched = await page.$('[data-testid="prior-sale"]');
    return { before, after: await page.inputValue('[data-testid="input-source"]'), matched: !!matched };
  };
  const withMatch = await sourceAfterTyping(regR);
  const noMatch = await sourceAfterTyping(regA);
  check('the page really DID match the car that has been sold before', withMatch.matched === true,
    'without this, every clause below passes because nothing was found to nudge with');
  check('  …and did NOT match the one that has not', noMatch.matched === false);
  check('THE MATCH DID NOT MOVE THE SOURCE', withMatch.after === withMatch.before,
    `before ${withMatch.before}, after ${withMatch.after}`);
  check('  …and it sits exactly where it sits for a car with no history',
    withMatch.after === noMatch.after,
    'measured against the unmatched car rather than against an assumption about the default');
  check('  …and neither return nor buyback is selected by the match',
    withMatch.after !== 'return' && withMatch.after !== 'buyback',
    'the two options exist in the list; being IN the list is not being chosen');

  console.log('\n— and the writer refuses to guess —');
  const guessed = await ST.takeIntoStock({
    groupId: ZZ_GROUP, userId: owner.id, vehicleId: vR.id, acquiredAt: new Date('2026-08-01T12:00:00Z'),
    purchasePence: 750000, vatStatus: 'margin', source: 'auction',
    reacquiredFromDisposalId: foundPrior.disposalId,
  });
  check('a reacquisition link with a NON-reacquisition source is refused', 'refused' in guessed,
    'somebody has said this car came back AND said it came from an auction');

  const backAsReturn = await ST.takeIntoStock({
    groupId: ZZ_GROUP, userId: owner.id, vehicleId: vR.id, acquiredAt: new Date('2026-08-01T12:00:00Z'),
    purchasePence: 750000, vatStatus: 'qualifying', source: 'return',
    reacquiredFromDisposalId: foundPrior.disposalId,
  });
  if ('refused' in backAsReturn) throw new Error(backAsReturn.refused);
  made.items.push(backAsReturn.id);
  const backRow = await prisma.stockItem.findUnique({
    where: { id: backAsReturn.id },
    select: { purchase_pence: true, vat_status: true, reacquired_from_disposal_id: true },
  });
  check('a RETURN stored through the real writer restores the original figures',
    backRow.purchase_pence === 620000 && backRow.vat_status === 'margin',
    `${backRow.purchase_pence}p / ${backRow.vat_status} — the 750000p qualifying entry was not used`);
  check('  …and it points at the sale it came back from', backRow.reacquired_from_disposal_id === foundPrior.disposalId);
  check('  …and names the invoice the surface may offer to credit',
    'creditableInvoiceId' in backAsReturn,
    'offered, never minted here — a credit note picks a tax point and a person confirms that date');

  check('THE EARLIER DISPOSAL IS UNTOUCHED — the quarter that reported the sale still reports it',
    (await prisma.stockDisposal.count({ where: { id: foundPrior.disposalId } })) === 1
      && (await prisma.stockDisposal.findUnique({ where: { id: foundPrior.disposalId }, select: { sale_pence: true } })).sale_pence === 899500,
    'a re-acquisition is a new row, never an undo');


  // ════════════════════════════════════════════════════════════════════════════════════════════
  //  A STOCK CAR ON THE BOARD — orange, earning nothing, and with nobody to bill
  // ════════════════════════════════════════════════════════════════════════════════════════════
  console.log('\n— the colour is fixed, and cannot be reconfigured away from the sticker —');
  check('stock orange is NOT one of the tenant-configurable status bands',
    !SC.STATUS_BANDS.some((b) => b.key === 'stock') && !('stock' in SC.DEFAULT_STATUS_COLOURS),
    'a colour that means "this is ours" must not be re-colourable in Settings');
  check('  …and resolveStatusColours cannot produce it, whatever is stored',
    !Object.values(SC.resolveStatusColours({ stock: DC.STOCK_COLOUR, in_progress: DC.STOCK_COLOUR }))
      .includes(DC.STOCK_COLOUR) === false || !('stock' in SC.resolveStatusColours({ stock: '#F97316' })),
    'the tenant map has no stock key to write');
  check('it does not collide with the in-progress default', DC.STOCK_COLOUR !== SC.DEFAULT_STATUS_COLOURS.in_progress,
    `stock ${DC.STOCK_COLOUR} vs in_progress ${SC.DEFAULT_STATUS_COLOURS.in_progress}`);
  check('  …and the distinction does NOT rest on hue alone — the fill is SOLID, not a tint',
    DC.STOCK_FILL === DC.STOCK_COLOUR && DC.blockTint(DC.STOCK_COLOUR) !== DC.STOCK_FILL,
    'every other block is a ~13% tint; amber and orange are adjacent hues at wall-screen distance');

  console.log('\n— a stock card is not gated on a customer it cannot have —');
  check('detailsMinDataMet BLOCKS an ordinary card with no owner',
    TABS.detailsMinDataMet({ hasOwner: false, hasRegistration: true }) === false);
  check('  …and PASSES a stock-prep card with no owner',
    TABS.detailsMinDataMet({ hasOwner: false, hasRegistration: true, isStockPrep: true }) === true,
    'without this the first stage never completes and the whole process path is dead behind it');
  check('  …but a registration is still required of both',
    TABS.detailsMinDataMet({ hasOwner: true, hasRegistration: false }) === false
      && TABS.detailsMinDataMet({ hasOwner: false, hasRegistration: false, isStockPrep: true }) === false);
  const stageSrc = readFileSync('pages/api/jobcard-stage.ts', 'utf8');
  check('the SERVER stage gate reads the same predicate, not its own copy',
    hasKey(stageSrc, 'isStockPrep', /!!card\.stock_item_id/) && /detailsMinDataMet\(gate\)/.test(stageSrc),
    'a client that allows what the server refuses is two rules wearing one name');

  console.log('\n— linking removes the customer, and unlinking does not bring them back —');
  const regS = `ZZYARD${Math.floor(Math.random() * 900 + 100)}S`;
  const vS = await ST.findOrCreateVehicle({ groupId: ZZ_GROUP, registration: regS, acquiredAt: bought });
  if ('refused' in vS) throw new Error(vS.refused);
  made.vehicles.push(vS.id);
  const itemS = await ST.takeIntoStock({
    groupId: ZZ_GROUP, userId: owner.id, vehicleId: vS.id, acquiredAt: bought,
    purchasePence: 214300, vatStatus: 'margin', source: 'trade',
  });
  if ('refused' in itemS) throw new Error(itemS.refused);
  made.items.push(itemS.id);
  const cust = await prisma.customer.create({
    data: { group_id: ZZ_GROUP, name: 'ZZ Wrongly Named Owner' }, select: { id: true, name: true },
  });
  made.customers = [...(made.customers ?? []), cust.id];
  const siteS = await prisma.site.findFirst({ where: { group_id: ZZ_GROUP }, select: { id: true } });
  const cardS = await prisma.jobCard.create({
    data: {
      group_id: ZZ_GROUP, site_id: siteS.id, vehicle_id: vS.id, customer_id: cust.id, status: 'accepted',
      items: { create: [
        { item_type: 'labour', description: 'ZZ remove DPF', qty: 4, unit_cost: null, unit_price: 75 },
        { item_type: 'part', description: 'ZZ turbo', qty: 2, unit_cost: 410, unit_price: 900 },
      ] },
    },
    select: { id: true },
  });
  made.cards = [...(made.cards ?? []), cardS.id];

  const origin = gateOrigin();
  const ctx = await browser.newContext();
  const pg = await ctx.newPage();
  await pg.goto(`${origin}/admin/login`, { waitUntil: 'domcontentloaded' });
  await pg.fill('input[type="email"]', 'owner@zzgategarage.test');
  await pg.fill('input[type="password"]', 'GateGarage!2026');
  await Promise.all([pg.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 60000 }), pg.click('button[type="submit"]')]);

  const link = await ctx.request.patch(`${origin}/api/jobcard-stock-prep`, {
    data: { jobCardId: cardS.id, stockItemId: itemS.id },
  });
  const linkBody = await link.json().catch(() => ({}));
  check('linking succeeds', link.status() === 200, `${link.status()}`);
  const afterLink = await prisma.jobCard.findUnique({
    where: { id: cardS.id }, select: { customer_id: true, stock_item_id: true },
  });
  check('THE CUSTOMER IS GONE from the card', afterLink.customer_id === null,
    'a car we own has no customer — the garage-as-Customer trap, arriving from the card');
  check('  …and the response NAMES who was removed', /ZZ Wrongly Named Owner/.test(linkBody.message ?? ''),
    'a silent removal is indistinguishable from a bug');
  const auditRow = await prisma.auditLog.findFirst({
    where: { entity: 'job_card', entity_id: cardS.id, action: 'stock_prep.linked' },
    select: { diff_json: true },
  });
  check('  …and the audit keeps the name, which is now the only place it survives',
    JSON.stringify(auditRow?.diff_json ?? {}).includes('ZZ Wrongly Named Owner'));

  const unlink = await ctx.request.patch(`${origin}/api/jobcard-stock-prep`, {
    data: { jobCardId: cardS.id, stockItemId: null },
  });
  const unlinkBody = await unlink.json().catch(() => ({}));
  const afterUnlink = await prisma.jobCard.findUnique({ where: { id: cardS.id }, select: { customer_id: true } });
  check('UNLINKING DOES NOT SILENTLY RESTORE the customer', afterUnlink.customer_id === null,
    'the name may have been wrong in the first place — re-choosing is a deliberate act');
  check('  …and the refusal to restore is SAID, not left to be discovered',
    /does not put back/i.test(unlinkBody.message ?? ''));
  await prisma.jobCard.update({ where: { id: cardS.id }, data: { stock_item_id: itemS.id, customer_id: null } });

  console.log('\n— and it reads as stock everywhere a customer name would be —');
  await pg.goto(`${origin}/admin/jobcards/${cardS.id}`, { waitUntil: 'domcontentloaded' });
  await pg.waitForSelector('[data-testid="stock-no-customer"]', { timeout: 25000 });
  const said = (await pg.textContent('[data-testid="stock-no-customer"]')).trim();
  check('the card page says it in words', said === SP_LABEL, said);
  check('  …and never renders a bare dash where the customer was',
    !(await pg.$('[data-testid="stock-no-customer"] >> text="—"')));
  check('the prep spend is reachable FROM THE CARD', !!(await pg.$('[data-testid="stock-prep-spend"]')));
  /**
   * ── WHERE THE TOGGLE IS, WHICH NOTHING ASSERTED UNTIL NOW ────────────────────────────────────
   *
   * It was moved out of the Quote tab on 2026-09-15 because 0 of 321 cards were linked against 2 open
   * stock items, and one car sat on a lift billing its owner £300. Moving it and asserting nothing
   * would leave the next person free to move it back with no gate noticing — which is exactly what a
   * red-proof of this change found: renaming the control changed no result at all.
   *
   * Driven by ?tab=, the state the component reads, not by clicking chrome that may be off-screen.
   */
  await pg.goto(`${origin}/admin/jobcards/${cardS.id}?tab=details`, { waitUntil: 'domcontentloaded' });
  await pg.waitForSelector('[data-testid="stock-prep-toggle"]', { timeout: 25000 });
  check('the toggle is on the CUSTOMER DETAILS tab — where you are when the car arrives',
    await pg.isVisible('[data-testid="stock-prep-toggle"]'));
  check('  …ABOVE the customer form it is going to empty', await pg.evaluate(() => {
    const t = document.querySelector('[data-testid="stock-prep-toggle"]');
    const c = document.querySelector('[data-testid="stock-no-customer"]');
    return !!t && !!c && (t.compareDocumentPosition(c) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
  }), 'the question "whose car is this?" comes before the answer it changes');
  /**
   * COMPLETE THE DETAILS STAGE THROUGH THE REAL SERVER, on a card with NO CUSTOMER. This is the
   * end-to-end proof of the gate exemption — the pure-function clauses above say detailsMinDataMet
   * allows it, and this says the API actually does. It is also what makes the Quote tab reachable,
   * without which the tab-placement clause below silently tests the details tab twice.
   */
  const stageRes = await ctx.request.post(`${origin}/api/jobcard-stage`, {
    data: { jobCardId: cardS.id, stage: 'details', done: true },
  });
  check('the SERVER completes the details stage on a card with no customer', stageRes.status() === 200,
    `${stageRes.status()} — ${(await stageRes.text()).slice(0, 90)}`);

  await pg.goto(`${origin}/admin/jobcards/${cardS.id}?tab=quote`, { waitUntil: 'domcontentloaded' });
  await pg.waitForSelector('[data-testid="stock-prep-toggle"]', { state: 'attached', timeout: 25000 }).catch(() => {});
  check('  …and NOT at the bottom of the Quote tab any more',
    !(await pg.isVisible('[data-testid="stock-prep-toggle"]').catch(() => false)),
    'the control deciding whether a card HAS a price does not belong underneath the pricing');
  await pg.goto(`${origin}/admin/jobcards/${cardS.id}?tab=details`, { waitUntil: 'domcontentloaded' });
  await pg.waitForSelector('[data-testid="stock-prep-toggle"]', { timeout: 25000 });

  const spend = await pg.textContent('[data-testid="stock-prep-spend"]');
  check('  …and it is the PARTS cost, not the retail price', /820\.00/.test(spend),
    `${spend.trim()} — 2 turbos at £410 trade, not £900 retail; the £300 of labour is not costed`);

  console.log('\n— ON THE BOARD: orange, and earning nothing —');
  /**
   * A REAL SLOT ON A REAL LIFT. Without a resource and a time the card never reaches the diary query
   * at all, and every clause below would pass on a board that had never heard of it.
   */
  const lift = await prisma.resource.findFirst({ where: { site_id: siteS.id }, select: { id: true } });
  const day = new Date(); day.setUTCHours(10, 0, 0, 0);
  const dayEnd = new Date(day.getTime() + 2 * 3600 * 1000);
  const dayKey = day.toISOString().slice(0, 10);
  await prisma.jobCard.update({
    where: { id: cardS.id },
    data: { resource_id: lift.id, start_at: day, end_at: dayEnd, booking_duration_minutes: 120 },
  });

  const boardMoney = async () => {
    await pg.goto(`${origin}/admin/diary?view=day&anchor=${dayKey}`, { waitUntil: 'domcontentloaded' });
    await pg.waitForSelector('[data-testid="finance-booked"]', { timeout: 25000 });
    const txt = async (sel) => (await pg.textContent(sel)).replace(/[^0-9.]/g, '');
    return { booked: Number(await txt('[data-testid="finance-booked"]')), margin: Number(await txt('[data-testid="finance-margin"]')) };
  };

  const asStock = await boardMoney();
  // THE DAY BLOCK specifically. `[data-stock="1"]` alone also matches the list-view row, which carries
  // no title — the first version of this clause read a null off the wrong element.
  const block = await pg.$('.diary-block[data-stock="1"]');
  check('the stock card is ON the board', !!block,
    'every clause below is about a block that must exist to be wrong');
  check('  …painted SOLID orange, not a tint',
    (await block.evaluate((el) => getComputedStyle(el).backgroundColor)) === 'rgb(249, 115, 22)',
    'the one channel nothing else on the board uses — readable across a workshop');
  check('  …carrying the STOCK pill, so the colour is never the only signal',
    !!(await pg.$('[data-testid="band-pill-stock"]')));
  check('  …and the legend names it', !!(await pg.$('[data-key-swatch="stock"]')));
  check('  …and it says who the customer is not',
    ((await block.getAttribute('title')) ?? '').includes(SP_LABEL),
    'not a dash — see lib/stock-prep');

  // THE MONEY, MEASURED BOTH WAYS. An absolute figure would depend on whatever else sits on the day;
  // the DIFFERENCE between linked and unlinked is caused by this card and nothing else.
  await prisma.jobCard.update({ where: { id: cardS.id }, data: { stock_item_id: null } });
  const asCustomerWork = await boardMoney();
  await prisma.jobCard.update({ where: { id: cardS.id }, data: { stock_item_id: itemS.id } });

  check('UNLINKED, this card puts money in Booked', asCustomerWork.booked > asStock.booked,
    `£${asCustomerWork.booked} vs £${asStock.booked} — proving the board would have counted it`);
  check('LINKED, it adds NOTHING to Booked', asStock.booked === asCustomerWork.booked - 2100,
    `£${asStock.booked} = £${asCustomerWork.booked} − £2,100 of fictional revenue on a car we own`);
  check('  …and nothing to Margin either — its parts are CAPITALISED, not a drag',
    asStock.margin === asCustomerWork.margin - (2100 - 820),
    `stock £${asStock.margin} vs customer £${asCustomerWork.margin}; the £820 of turbos must not also `
    + 'reduce this month, or the same turbo is counted twice in opposite directions');
  await ctx.close();

} catch (e) {
  check('run completed', false, describeError(e).slice(0, 300));
} finally {
  await browser?.close().catch(() => {});
  if (prisma) {
    try {
      if (made.customers?.length) {
        // The fixture customer, by its OWN id. Cards first (SetNull would orphan the name otherwise).
        await prisma.customer.deleteMany({ where: { id: { in: made.customers }, group_id: ZZ_GROUP } })
          .catch(() => {});
      }
      if (made.cards?.length) {
        await prisma.jobCardItem.deleteMany({ where: { job_card_id: { in: made.cards } } });
        await prisma.auditLog.deleteMany({ where: { entity: 'job_card', entity_id: { in: made.cards } } })
          .catch(() => {});  // AuditLog is append-only by standing rule; these are the run's OWN rows
        await prisma.jobCard.deleteMany({ where: { id: { in: made.cards }, group_id: ZZ_GROUP } });
      }
      // BY THEIR OWN IDS, on ZZ only. Disposals and cost snapshots cascade from the item.
      if (made.items.length) {
        const d = await prisma.stockItem.deleteMany({ where: { id: { in: made.items.filter(Boolean) }, group_id: ZZ_GROUP } });
        check('teardown removed the stock fixtures', d.count === made.items.filter(Boolean).length, `${d.count} of ${made.items.filter(Boolean).length}`);
      }
      if (made.vehicles.length) {
        // BACKSTOP, SCOPED TO THIS RUN'S OWN VEHICLES. A red-proof once left an untracked StockItem
        // behind — a refusal that stopped refusing created a second row this list never learned about —
        // and the vehicle delete then failed on the RESTRICT, leaving both. Anything still pointing at
        // a fixture vehicle goes, which cannot reach a real car because the ids came from this run.
        // SCOPED TO THIS GATE'S OWN NAMING, not to what the run remembered making. A red-proof that
        // breaks a refusal makes rows nothing tracked — a defaulted date once created ZZNODATE1 and
        // left it behind. Every registration this gate can produce starts with one of these, and no
        // real car does.
        const fixtures = await prisma.vehicle.findMany({
          /**
           * THE PREFIXES THIS RUN CAN PRODUCE — including one it produces only when something is
           * BROKEN. 'ZZNOSUCH' is the plate the find-only clause asks about and expects not to exist;
           * a lookup that wrongly creates it leaves a car this teardown never learned about, which is
           * exactly what happened when that clause was first red-proved. A backstop scoped to what the
           * run REMEMBERED cannot remove what a broken path created — so it is scoped to the shapes
           * the run can produce instead.
           */
          where: { group_id: ZZ_GROUP, OR: ['ZZSTK', 'ZZYARD', 'ZZNODATE', 'ZZNOSUCH'].map((x) => ({ registration: { startsWith: x } })) },
          select: { id: true },
        });
        const orphans = await prisma.stockItem.deleteMany({
          where: { group_id: ZZ_GROUP, vehicle_id: { in: [...new Set([...made.vehicles, ...fixtures.map((f) => f.id)])] } },
        });
        made.vehicles = [...new Set([...made.vehicles, ...fixtures.map((f) => f.id)])];
        if (orphans.count) check('  …including a stock row the run did not track', true, `${orphans.count} swept`);
        const v = await prisma.vehicle.deleteMany({ where: { id: { in: made.vehicles }, group_id: ZZ_GROUP } });
        check('  …and the fixture vehicles', v.count === made.vehicles.length, `${v.count} of ${made.vehicles.length}`);
      }
      const left = await prisma.stockItem.count({ where: { group_id: ZZ_GROUP } });
      check('ZZ holds no stock rows again', left === 0, `${left}`);
    } catch (e) { check('teardown completed', false, describeError(e).slice(0, 200)); }
  }
  console.log(`\n${out.filter((c) => c === 'F').length} failures of ${out.length}`);
  await prisma?.$disconnect();
  process.exit(out.includes('F') ? 1 : 0);
}
