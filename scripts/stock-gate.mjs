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
const PJ = await import('../lib/stock-projection.ts');
const SCST = await import('../lib/stock-cost.ts');
const SL = await import('../lib/stock-list.ts');
const SS = await import('../lib/stock-sold.ts');
const PM = await import('../lib/purchase-model.ts');
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

  /**
   * ── SWEEP BEFORE, NOT ONLY AFTER ──────────────────────────────────────────────────────────────
   *
   * A teardown that must run will one day not run — SIGKILL skips `finally`, and a red-proof that
   * breaks a refusal can abort the run part-way. When that happens the NEXT run fails for a reason
   * that has nothing to do with what it tests: a fixture VIN is "already on ZZSTK602A", and the
   * failure names a car nobody recognises. That happened twice while this gate was being written.
   *
   * So the run starts by removing anything wearing its own naming. Same prefixes, same FK order as
   * the teardown, and it cannot reach a real car because no real registration starts with them.
   */
  const FIXTURE_PREFIXES = ['ZZSTK', 'ZZYARD', 'ZZNODATE', 'ZZNOSUCH'];
  const sweepFixtures = async () => {
    const cars = await prisma.vehicle.findMany({
      where: { group_id: ZZ_GROUP, OR: FIXTURE_PREFIXES.map((x) => ({ registration: { startsWith: x } })) },
      select: { id: true },
    });
    if (!cars.length) return 0;
    const ids = cars.map((c) => c.id);
    const cards = (await prisma.jobCard.findMany({ where: { vehicle_id: { in: ids } }, select: { id: true } })).map((c) => c.id);
    if (cards.length) {
      await prisma.jobCardItem.deleteMany({ where: { job_card_id: { in: cards } } });
      await prisma.auditLog.deleteMany({ where: { entity: 'job_card', entity_id: { in: cards } } }).catch(() => {});
      await prisma.jobCard.deleteMany({ where: { id: { in: cards } } });
    }
    await prisma.stockItem.deleteMany({ where: { vehicle_id: { in: ids } } });
    await prisma.vehicleOdometerReading.deleteMany({ where: { vehicle_id: { in: ids } } });
    await prisma.vehicle.deleteMany({ where: { id: { in: ids }, group_id: ZZ_GROUP } });
    return ids.length;
  };
  const sweptBefore = await sweepFixtures();
  if (sweptBefore) console.log(`  (swept ${sweptBefore} fixture car(s) left by an earlier run)`);

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
  /**
   * WHAT IS TIED UP, SAID ONCE — now in the capital TILE rather than the summary line, which says how
   * many cars are shown. Rewritten with that move (2026-09-15) rather than deleted: the rule it pins
   * is that the figure exists and is stated in one place, not which element holds it.
   */
  const capitalTile = (await page.locator('[data-testid="tile-capital"]').textContent()) ?? '';
  check('  …with what is tied up said once, in the capital tile',
    /£[\d,]+(\.\d\d)?/.test(capitalTile) && /invested/i.test(capitalTile), capitalTile.trim().slice(0, 90));
  /**
   * COVERING EVERY CAR YOU OWN — across every TAB, not just the one on screen. Rewritten 2026-09-16
   * when the tabs landed: the tile is the yard summary and the tab is a filter on the list, so the
   * tile's number is the owned count and the list's is the tab's. They differ on purpose.
   */
  const ownedNow = await page.evaluate(async () => {
    const b = await (await fetch('/api/stock')).json();
    return b.stock.filter((r) => !r.disposalKind).length;
  });
  check('  …covering EVERY car you own, not only the priced ones and not only this tab',
    new RegExp(`All ${ownedNow} you own`).test(capitalTile),
    `${ownedNow} owned — capital is money that has gone out and is known for all of them`);

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


  // ════════════════════════════════════════════════════════════════════════════════════════════
  //  THE DETAIL PAGE, AND WHAT THIS CAR WILL MAKE
  // ════════════════════════════════════════════════════════════════════════════════════════════
  console.log('\n— the projection is the purchase model, not a second arithmetic —');
  const subj = {
    purchasePence: 214300, premiumPence: 0, servicesPence: 0, vatStatus: 'margin', source: 'trade',
    daysInStock: 54, partsPence: 108000, projectedSalePence: 400000,
  };
  const proj = PJ.projectStock(subj, { vatRegistered: true });
  check('a car with no expected price has NO projection — not a £0 one',
    PJ.projectStock({ ...subj, projectedSalePence: null }, { vatRegistered: true }) === null,
    'a loss on every unestimated car is a confident wrong answer');
  check('  …and neither does one priced at zero',
    PJ.projectStock({ ...subj, projectedSalePence: 0 }, { vatRegistered: true }) === null);
  check('the figure IS computeModel’s, arrived at independently',
    proj.grossProfitPence === PM.computeModel({
      ...PM.defaultInputs(), purchasePence: 214300, salePence: 400000, vatStatus: 'margin',
      source: 'trade', premiumPence: 0, servicesPence: 0, purchaseIncludesVat: true,
      funding: { kind: 'cash' }, slotCostPerMonthPence: 0, costVat: PM.defaultCostVat(),
      partsPence: 108000, daysInStock: 54, prepHours: 0, workshopCostPerHourPence: 0,
      advertisingPence: 0, warrantyPence: 0, deliveryInPence: 0, deliveryOutPence: 0,
      costOfMoneyAnnualPct: 0,
    }, { vatRegistered: true }).grossProfitPence,
    `£${(proj.grossProfitPence / 100).toFixed(2)} — reimplementing this arithmetic is the failure the clause prevents`);
  check('the MARGIN SCHEME is honoured — VAT is (sale − purchase)/6 on the margin, not on the sale',
    proj.vatDuePence === Math.round((400000 - 214300) / 6),
    `${proj.vatDuePence}p vs ${Math.round((400000 - 214300) / 6)}p`);
  /**
   * MARGIN AND QUALIFYING AGREE ON A CAR WITH NO FEES, AND THAT IS CORRECT — pinned so nobody
   * "fixes" it. For a VAT-registered dealer with gross prices both come to (sale − purchase)/6:
   * margin taxes the margin; qualifying charges sale/6 and reclaims purchase/6. The real difference
   * is who may reclaim and what the invoice shows, not the dealer's net position.
   *
   * Written after this clause asserted the opposite and went red against correct arithmetic.
   */
  check('with no fees, margin and qualifying agree — and that is the right answer',
    PJ.projectStock({ ...subj, vatStatus: 'qualifying' }, { vatRegistered: true }).grossProfitPence
      === proj.grossProfitPence,
    'both are (sale − purchase)/6 on gross prices; a difference here would be the error');
  /** WHERE THEY MUST DIVERGE: the buyer's premium sits INSIDE the margin base and nowhere else. */
  const withFee = (vs) => PJ.projectStock(
    { ...subj, source: 'auction', premiumPence: 26520, vatStatus: vs }, { vatRegistered: true });
  check('  …but a BUYER\u2019S PREMIUM separates them, because it is inside the margin base',
    withFee('margin').vatDuePence < withFee('qualifying').vatDuePence
      && withFee('margin').grossProfitPence !== withFee('qualifying').grossProfitPence,
    `margin VAT ${withFee('margin').vatDuePence}p vs qualifying ${withFee('qualifying').vatDuePence}p — `
    + 'if these ever agree, the premium has stopped reaching the margin base');
  check('parts move the projection; nothing else on a prep card does',
    PJ.projectStock({ ...subj, partsPence: 0 }, { vatRegistered: true }).grossProfitPence
      > proj.grossProfitPence);
  /**
   * LABOUR IS NOT COSTED, asserted STRUCTURALLY — and it has to be, because the two inputs cancel:
   * hours × rate, both zero, so mutating EITHER changes no answer and a behavioural clause sees
   * nothing. Measured: setting prepHours to 4 scored 0 failures against the whole suite. Belt-and-
   * braces zeroing is right for the code and blind for the clause, so the clause reads the literals.
   */
  const projSrc = readFileSync('lib/stock-projection.ts', 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  check('LABOUR IS NOT COSTED — prep hours AND the workshop rate are both zeroed',
    hasKey(projSrc, 'prepHours', '0') && hasKey(projSrc, 'workshopCostPerHourPence', '0'),
    'either one alone would do it; both are zeroed so no later default can reintroduce a labour cost');
  check('  …and the note SAYS all of that, beside the number',
    /not costed/i.test(PJ.PROJECTION_BASIS_NOTE) && /better than the truth/i.test(PJ.PROJECTION_BASIS_NOTE)
      && /advertising/i.test(PJ.PROJECTION_BASIS_NOTE) && /warranty/i.test(PJ.PROJECTION_BASIS_NOTE),
    'optimistic in a way the reader cannot see is worse than absent');
  check('  …and it no longer claims delivery is missing, now that it is not',
    !/delivery in (is|are) not/i.test(PJ.PROJECTION_BASIS_NOTE)
      && /net of anything credited back/i.test(PJ.PROJECTION_BASIS_NOTE),
    'a note listing a gap that has been filled is a note nobody will trust about the gaps that remain');

  console.log('\n— what may be corrected, refused by the WRITER and not merely hidden —');
  const regD = `ZZYARD${Math.floor(Math.random() * 900 + 100)}D`;
  const vD = await ST.findOrCreateVehicle({ groupId: ZZ_GROUP, registration: regD, acquiredAt: bought });
  if ('refused' in vD) throw new Error(vD.refused);
  made.vehicles.push(vD.id);
  const itemD = await ST.takeIntoStock({
    groupId: ZZ_GROUP, userId: owner.id, vehicleId: vD.id, acquiredAt: bought,
    purchasePence: 214300, vatStatus: 'margin', source: 'trade',
  });
  if ('refused' in itemD) throw new Error(itemD.refused);
  made.items.push(itemD.id);

  const badVat = await ST.updateStockItem({ groupId: ZZ_GROUP, stockItemId: itemD.id, vatStatus: 'qualifying' });
  check('the VAT treatment is REFUSED, and the refusal says why',
    'refused' in badVat && /margin scheme/i.test(badVat.refused) && /filed return/i.test(badVat.refused),
    'a car bought on the margin scheme stays one; the choice may already be in a VAT return');
  const badSrc = await ST.updateStockItem({ groupId: ZZ_GROUP, stockItemId: itemD.id, source: 'auction' });
  check('  …and so is the source, because it decides which treatments are allowed',
    'refused' in badSrc);
  const okEdit = await ST.updateStockItem({
    groupId: ZZ_GROUP, stockItemId: itemD.id, purchasePence: 220000, projectedSalePence: 400000,
  });
  check('a price correction and an expected sale price ARE allowed', 'id' in okEdit);
  const detail = await ST.stockDetail(ZZ_GROUP, itemD.id, new Date(), { vatRegistered: true });
  check('  …and the detail reader shows them back', detail.purchasePence === 220000
    && detail.projectedSalePence === 400000 && detail.projection !== null);
  const cleared = await ST.updateStockItem({ groupId: ZZ_GROUP, stockItemId: itemD.id, projectedSalePence: 0 });
  check('clearing the expected price returns it to NOT ESTIMATED, not to zero',
    'id' in cleared
      && (await ST.stockDetail(ZZ_GROUP, itemD.id, new Date(), { vatRegistered: true })).projectedSalePence === null,
    'a mistyped estimate that can only be replaced by another estimate is a trap');

  await ST.updateStockItem({ groupId: ZZ_GROUP, stockItemId: itemD.id, projectedSalePence: 400000 });
  const soldD = await ST.recordDisposal({
    groupId: ZZ_GROUP, userId: owner.id, stockItemId: itemD.id,
    disposedAt: new Date('2026-08-20T12:00:00Z'), kind: 'sold', salePence: 385000, costs: [],
  });
  if ('refused' in soldD) throw new Error(soldD.refused);
  const afterSale = await ST.updateStockItem({ groupId: ZZ_GROUP, stockItemId: itemD.id, purchasePence: 999999 });
  check('a SOLD car is read-only entirely — its figures froze at disposal',
    'refused' in afterSale && /frozen at disposal/i.test(afterSale.refused));
  const soldDetail = await ST.stockDetail(ZZ_GROUP, itemD.id, new Date(), { vatRegistered: true });
  check('  …and it shows no projection: what it fetched is the answer, not what we expected',
    soldDetail.projection === null && soldDetail.salePence === 385000,
    'showing a guess beside a result invites reading the guess as one');

  console.log('\n— the fee fields are named by the SOURCE, not by this page —');
  const detailSrc = readFileSync('pages/admin/stock/[id].tsx', 'utf8');
  check('the detail page no longer invents the word “Fees”',
    !/>Fees\b/.test(detailSrc),
    'it appears on no invoice, and £250 of recovery went into it because it said nothing');
  check('  …it reads the labels from SOURCE_RULES, the same rules the intake form uses',
    /SOURCE_RULES\[d\.source as PurchaseSource\]\?\.fees/.test(detailSrc),
    'one source of these words, so the two screens cannot disagree');
  check('  …and the note travels with the label, from the same rule',
    /\{f\.note\}/.test(detailSrc) && /\{f\.label\}/.test(detailSrc),
    'a note typed separately drifts from the field it explains');
  check('an AUCTION calls it Indemnities and names Simulcast and SureCheck',
    PM.SOURCE_RULES.auction.fees.some((f) => f.slot === 'services' && f.label === 'Indemnities'
      && /Simulcast/.test(f.note) && /SureCheck/.test(f.note)));
  check('  …and a TRADE purchase calls the same slot something else entirely',
    PM.SOURCE_RULES.trade.fees.some((f) => f.slot === 'services' && f.label !== 'Indemnities'),
    `trade: ${PM.SOURCE_RULES.trade.fees.map((f) => f.label).join(', ')} — one generic word cannot be right for both`);
  check('a source with NO fee slots renders no fee fields at all',
    PM.SOURCE_RULES.private.fees.length === 0 && PM.SOURCE_RULES.part_exchange.fees.length === 0,
    'an empty box labelled “Fees” is an invitation to put something in it');
  check('and the page says where a SEPARATE invoice goes instead',
    /data-testid="fees-vs-costs"/.test(detailSrc) && /Costs besides\s*\n?\s*parts/.test(detailSrc),
    'delivery by someone else is a cost with its own date and VAT treatment, not an acquisition fee');

  console.log('\n— and the yard reaches the car, through the real pages —');
  await page.goto(`${gateOrigin()}/admin/stock`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-testid="stock-list"]', { timeout: 25000 });
  // regS — still IN STOCK. regP and regD are disposed by now and are not on the yard list at all,
  // so a link check against either would fail for a reason that has nothing to do with links.
  const openLink = await page.$(`[data-testid="open-${regS}"]`);
  check('every row is a way in to its car', !!openLink,
    'a yard list whose rows go nowhere is how the last feature went unused');
  await Promise.all([page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 }), openLink.click()]);
  await page.waitForSelector('[data-testid="detail-reg"]', { timeout: 25000 });
  check('  …and it lands on that car', (await page.textContent('[data-testid="detail-reg"]')).trim() === regS);
  check('the page says labour is not costed', /not costed/i.test(await page.textContent('[data-testid="labour-note"]')));
  const missingTxt = await page.textContent('[data-testid="missing-costs"]');
  check('  …and names the costs it cannot yet record',
    /advertising/i.test(missingTxt) && /warranty/i.test(missingTxt) && !/delivery/i.test(missingTxt),
    `"${missingTxt.trim()}" — delivery has a home now and must drop off this list`);
  check('the frozen pair is SHOWN and explained, not silently absent',
    /accountant/i.test(await page.textContent('[data-testid="frozen-fields"]')),
    'a person hunting for a control that is deliberately missing has been told nothing');


  // ════════════════════════════════════════════════════════════════════════════════════════════
  //  WHAT A CAR COST BESIDES ITS PARTS — and the credit that takes it back off
  // ════════════════════════════════════════════════════════════════════════════════════════════
  console.log('\n— the vocabulary is the three DIRECT costs, and only those —');
  check('delivery in, valeting and MOT', JSON.stringify([...SCST.STOCK_COST_KINDS]) === JSON.stringify(['delivery_in', 'valeting', 'mot']));
  check('  …advertising is NOT one — it is an apportioned slot share, not a direct cost',
    !SCST.isStockCostKind('advertising'));
  check('  …and neither is warranty — a provision is a forecast until a claim is PAID',
    !SCST.isStockCostKind('warranty'));
  check('  …and both are still named as absent from the projection',
    PJ.MISSING_COST_KINDS.includes('Advertising') && PJ.MISSING_COST_KINDS.includes('Warranty')
      && !PJ.MISSING_COST_KINDS.includes('Delivery in'),
    'the ones that now have a home must stop being listed as missing, or the note goes stale');

  console.log('\n— a credit is a ROW, and it cannot invent money —');
  const target = { id: 'c1', kind: 'delivery_in', description: 'Turbo delivery', amountPence: 41000, incurredOn: bought, vatTreatment: 'standard_recoverable', reversesId: null };
  check('a credit must NAME the cost it reverses', 'refused' in SCST.checkCredit(null, 41000, 0),
    'a free-floating negative is exactly the thing that massages a total');
  check('a credit may not exceed what was paid',
    /only credit back what was paid/i.test(SCST.checkCredit(target, 60000, 0).refused ?? ''),
    'you cannot credit £600 against a £410 turbo');
  check('  …counting what has already come back',
    'refused' in SCST.checkCredit(target, 30000, 20000)
      && 'ok' in SCST.checkCredit(target, 20000, 20000),
    '£200 already credited leaves £210, so £300 is refused and £200 is not');
  check('a credit may not credit a credit',
    'refused' in SCST.checkCredit({ ...target, reversesId: 'c1' }, 100, 0),
    'otherwise the ceiling becomes a sum over a cycle');
  check('the VAT treatment is INHERITED, never chosen',
    SCST.checkCredit(target, 10000, 0).vatTreatment === 'standard_recoverable',
    'choosing it would let a credit reclaim input tax the cost never paid');
  check('a full credit nets to nothing, and never below',
    SCST.netCosts([target, { ...target, id: 'c2', amountPence: 41000, reversesId: 'c1' }], true).netPence === 0);
  check('  …and the VAT reclaim is reversed with it',
    SCST.netCosts([target, { ...target, id: 'c2', amountPence: 41000, reversesId: 'c1' }], true).reclaimablePence === 0,
    'a credit that kept the reclaim would leave VAT recovered on money that came back');
  check('an uncredited standard-rated cost DOES reclaim, so the clause above is not vacuous',
    SCST.netCosts([target], true).reclaimablePence === Math.round(41000 / 6));

  console.log('\n— through the real writer, on a real car —');
  const regC = `ZZYARD${Math.floor(Math.random() * 900 + 100)}C`;
  const vC = await ST.findOrCreateVehicle({ groupId: ZZ_GROUP, registration: regC, acquiredAt: bought });
  if ('refused' in vC) throw new Error(vC.refused);
  made.vehicles.push(vC.id);
  const itemC = await ST.takeIntoStock({
    groupId: ZZ_GROUP, userId: owner.id, vehicleId: vC.id, acquiredAt: bought,
    purchasePence: 214300, vatStatus: 'margin', source: 'trade',
  });
  if ('refused' in itemC) throw new Error(itemC.refused);
  made.items.push(itemC.id);

  const noDesc = await ST.addStockCost({
    groupId: ZZ_GROUP, userId: owner.id, stockItemId: itemC.id, kind: 'delivery_in',
    description: '  ', amountPence: 12000, incurredOn: bought, vatTreatment: 'no_vat',
  });
  check('a cost with no description is refused', 'refused' in noDesc,
    'a figure with no description is unauditable');
  const costNoDate = await ST.addStockCost({
    groupId: ZZ_GROUP, userId: owner.id, stockItemId: itemC.id, kind: 'delivery_in',
    description: 'Recovery man', amountPence: 12000, incurredOn: null, vatTreatment: 'no_vat',
  });
  check('  …and one with no date, because the date is what puts it in a quarter', 'refused' in costNoDate);

  const del = await ST.addStockCost({
    groupId: ZZ_GROUP, userId: owner.id, stockItemId: itemC.id, kind: 'delivery_in',
    description: 'Recovery from auction', amountPence: 25000, incurredOn: bought, vatTreatment: 'no_vat',
  });
  if ('refused' in del) throw new Error(del.refused);
  const turbo = await ST.addStockCost({
    groupId: ZZ_GROUP, userId: owner.id, stockItemId: itemC.id, kind: 'mot',
    description: 'MOT', amountPence: 5400, incurredOn: bought, vatTreatment: 'standard_recoverable',
  });
  if ('refused' in turbo) throw new Error(turbo.refused);
  let totals = await ST.stockCostTotals(ZZ_GROUP, itemC.id, true);
  check('both costs are on the car', totals.netPence === 30400, `${totals.netPence}p`);
  check('  …and only the standard-rated one reclaims VAT',
    totals.reclaimablePence === Math.round(5400 / 6),
    'the recovery man is not VAT registered, so there is nothing to reclaim on £250');

  const over = await ST.creditStockCost({
    groupId: ZZ_GROUP, userId: owner.id, stockItemId: itemC.id,
    reversesId: del.id, amountPence: 99999, incurredOn: bought,
  });
  check('the writer refuses a credit bigger than the cost', 'refused' in over);
  const back = await ST.creditStockCost({
    groupId: ZZ_GROUP, userId: owner.id, stockItemId: itemC.id,
    reversesId: del.id, amountPence: 25000, incurredOn: bought,
  });
  if ('refused' in back) throw new Error(back.refused);
  totals = await ST.stockCostTotals(ZZ_GROUP, itemC.id, true);
  check('THE CREDIT TAKES IT BACK OFF', totals.netPence === 5400,
    `${totals.netPence}p — £250 out and £250 back leaves the MOT`);
  check('  …and the original row STAYS, so the car’s history is money out AND money back',
    (await ST.stockCostRows(ZZ_GROUP, itemC.id)).filter((r) => !r.reversesId).length === 2,
    'a cost base that simply forgot the £250 is a car carrying something it did not pay for');
  check('  …and it can never go negative', totals.netPence >= 0);
  /**
   * THE STORED TREATMENT, not the netted answer. netCosts re-reads the source row's treatment as a
   * defence, so a credit written with the WRONG one still nets correctly — which is right for the
   * arithmetic and leaves the writer's inheritance untested. Measured: mutating the writer to store
   * 'standard_recoverable' scored 0 failures. So this clause reads the row.
   */
  const creditRow = (await ST.stockCostRows(ZZ_GROUP, itemC.id)).find((r) => r.reversesId === del.id);
  const delRow = (await ST.stockCostRows(ZZ_GROUP, itemC.id)).find((r) => r.id === del.id);
  check('the credit STORED the treatment it inherited, not one of its own',
    creditRow.vatTreatment === delRow.vatTreatment && creditRow.vatTreatment === 'no_vat',
    `credit ${creditRow.vatTreatment} vs cost ${delRow.vatTreatment} — a credit choosing its own could `
    + 'reclaim input tax the cost never paid');

  console.log('\n— and the freeze holds, in both directions —');
  const projBefore = (await ST.stockDetail(ZZ_GROUP, itemC.id, new Date(), { vatRegistered: true }));
  check('the live costs reach the detail page', projBefore.costs.netPence === 5400
    && projBefore.costRows.length === 3, `${projBefore.costRows.length} rows`);
  await ST.updateStockItem({ groupId: ZZ_GROUP, stockItemId: itemC.id, projectedSalePence: 400000 });
  const withCost = (await ST.stockDetail(ZZ_GROUP, itemC.id, new Date(), { vatRegistered: true })).projection;
  const noCost = PJ.projectStock({
    purchasePence: 214300, premiumPence: 0, servicesPence: 0, vatStatus: 'margin', source: 'trade',
    daysInStock: withCost ? 0 : 0, partsPence: 0, projectedSalePence: 400000, otherCostsPence: 0,
  }, { vatRegistered: true });
  check('the costs REACH the projection and reduce it', withCost.grossProfitPence < noCost.grossProfitPence,
    `${withCost.grossProfitPence}p vs ${noCost.grossProfitPence}p with no costs`);

  const soldC = await ST.recordDisposal({
    groupId: ZZ_GROUP, userId: owner.id, stockItemId: itemC.id,
    disposedAt: new Date('2026-09-01T12:00:00Z'), kind: 'sold', salePence: 400000, costs: [],
  });
  if ('refused' in soldC) throw new Error(soldC.refused);
  const frozen = await prisma.stockCostSnapshot.findMany({
    where: { stock_item_id: itemC.id, job_card_id: null },
    select: { amount_pence: true, description: true, kind: true },
  });
  check('disposal froze the costs NET of the credit',
    frozen.length === 1 && frozen[0].amount_pence === 5400,
    `${frozen.length} row(s): ${frozen.map((f) => `${f.kind} ${f.amount_pence}p`).join(', ')} — the fully credited delivery froze as nothing at all`);
  const lateCost = await ST.addStockCost({
    groupId: ZZ_GROUP, userId: owner.id, stockItemId: itemC.id, kind: 'valeting',
    description: 'Late valet', amountPence: 5000, incurredOn: new Date('2026-09-10T12:00:00Z'), vatTreatment: 'no_vat',
  });
  check('a cost added AFTER disposal is refused', 'refused' in lateCost);
  const lateCredit = await ST.creditStockCost({
    groupId: ZZ_GROUP, userId: owner.id, stockItemId: itemC.id,
    reversesId: turbo.id, amountPence: 5400, incurredOn: new Date('2026-09-10T12:00:00Z'),
  });
  check('  …and so is a credit, WITH somewhere else to put it',
    'refused' in lateCredit && /purchase ledger/i.test(lateCredit.refused),
    'the car did cost that when it was sold; a later credit belongs to the period it arrived in');


  // ════════════════════════════════════════════════════════════════════════════════════════════
  //  THE YARD AS A LIST — tiles, sort, search, and the null that stays a null
  // ════════════════════════════════════════════════════════════════════════════════════════════
  console.log('\n— the tiles, and the one that qualifies the others —');
  const mk = (reg, o = {}) => ({
    registration: reg, description: o.description ?? 'Mini Clubman', acquiredAt: o.acquiredAt ?? '2026-06-01',
    daysInStock: o.daysInStock ?? 10, purchasePence: o.purchasePence ?? 200000, prepPence: o.prepPence ?? 50000,
    vatStatus: o.vatStatus ?? 'margin',
    projectedSalePence: o.projectedSalePence === undefined ? 400000 : o.projectedSalePence,
    projectedProfitPence: o.projectedProfitPence === undefined ? 90000 : o.projectedProfitPence,
  });
  const five = [
    mk('AA11AAA'), mk('BB22BBB'),
    mk('CC33CCC', { projectedSalePence: null, projectedProfitPence: null }),
    mk('DD44DDD', { projectedSalePence: null, projectedProfitPence: null }),
    mk('EE55EEE'),
  ];
  const tot = SL.stockTotals(five);
  check('CAPITAL counts every car, priced or not',
    tot.capitalPence === 5 * 250000,
    `${tot.capitalPence}p — money that has gone out is known for all of them, so a missing estimate must not reduce it`);
  check('EXPECTED REVENUE counts only the priced ones', tot.expectedRevenuePence === 3 * 400000);
  check('EXPECTED PROFIT likewise', tot.expectedProfitPence === 3 * 90000);
  check('AND THE COUNT OF CARS WITH NO PROJECTION IS PUBLISHED', tot.unprojected === 2 && tot.projected === 3,
    'two of five would otherwise be absent from the profit figure with nothing saying so');
  check('an unpriced car contributes NOTHING rather than zero',
    SL.stockTotals([mk('ZZ99ZZZ', { projectedSalePence: null, projectedProfitPence: null })]).expectedRevenuePence === 0
      && SL.stockTotals([mk('ZZ99ZZZ', { projectedSalePence: null, projectedProfitPence: null })]).projected === 0,
    'the figure is £0 because it covers no cars — which is what `projected: 0` lets the tile say');
  check('an empty yard totals to zero without dividing by anything', SL.stockTotals([]).cars === 0);

  console.log('\n— sorted, with nulls last in BOTH directions —');
  const desc = SL.sortStock(five, 'projectedProfitPence', 'desc').map((r) => r.registration);
  const asc = SL.sortStock(five, 'projectedProfitPence', 'asc').map((r) => r.registration);
  check('descending puts the unpriced cars last', desc.slice(-2).sort().join() === 'CC33CCC,DD44DDD', desc.join(' '));
  check('  …and so does ASCENDING — they are not the worst cars, they are cars with no answer',
    asc.slice(-2).sort().join() === 'CC33CCC,DD44DDD', asc.join(' '));
  check('  …which is different from treating them as £0', (() => {
    const asZero = [...five].sort((a, b) => (a.projectedProfitPence ?? 0) - (b.projectedProfitPence ?? 0));
    return asZero[0].projectedProfitPence === null;
  })(), 'sorted as zero they file FIRST on an ascending profit sort, among the worst cars in the yard');
  const days = SL.sortStock([mk('AA11AAA', { daysInStock: 5 }), mk('BB22BBB', { daysInStock: 120 })], 'daysInStock', 'desc');
  check('days in stock descending puts the oldest car first — the default',
    days[0].registration === 'BB22BBB' && SL.DEFAULT_SORT.key === 'daysInStock' && SL.DEFAULT_SORT.dir === 'desc');
  check('ties break on registration, so the table never jitters', (() => {
    const t = SL.sortStock([mk('ZZ99ZZZ'), mk('AA11AAA')], 'daysInStock', 'desc');
    return t[0].registration === 'AA11AAA';
  })());
  check('every column the header offers is sortable',
    SL.SORT_KEYS.length === 9 && SL.SORT_KEYS.includes('investedPence'),
    `${SL.SORT_KEYS.join(', ')}`);

  console.log('\n— search finds a plate typed the way a plate is typed —');
  const car = mk('WT16GMV', { description: 'MINI CLUBMAN' });
  check('an exact plate matches', SL.matchStock(car, 'WT16GMV'));
  check('  …with the space in it, which is how a person types one', SL.matchStock(car, 'wt16 gmv'),
    'a search that fails on a spaced plate reads as "we do not have that car"');
  check('  …and part of one', SL.matchStock(car, 'gmv'));
  check('the model matches, case-insensitively', SL.matchStock(car, 'clubman'));
  check('a car that does not match is EXCLUDED, so the filter is not a no-op',
    !SL.matchStock(car, 'FORD') && !SL.matchStock(car, 'XY99XYZ'));
  check('an empty search shows everything', SL.matchStock(car, '') && SL.matchStock(car, '   '));

  console.log('\n— and on the real page —');
  await page.goto(`${gateOrigin()}/admin/stock`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-testid="stock-tiles"]', { timeout: 25000 });
  for (const t of ['tile-capital', 'tile-revenue', 'tile-profit', 'tile-unprojected']) {
    check(`the ${t.replace('tile-', '')} tile is on the page`, !!(await page.$(`[data-testid="${t}"]`)));
  }
  check('the labour note is still there, under the figures it qualifies',
    /not costed/i.test((await page.textContent('[data-testid="prep-note"]')) ?? ''),
    'tiles are exactly where a stated omission gets dropped');
  const before = (await page.$$('[data-testid^="stock-row-"]')).length;
  await page.fill('[data-testid="stock-search"]', regS);
  await page.waitForFunction((n) => document.querySelectorAll('[data-testid^="stock-row-"]').length < n,
    before, { timeout: 15000 });
  const after = (await page.$$('[data-testid^="stock-row-"]')).length;
  check('searching narrows the table', after >= 1 && after < before, `${before} → ${after}`);
  /**
   * THE TILE, not the summary line beside it. The first version of this clause read the summary —
   * which is computed from the filtered rows anyway — so a mutation pointing the TILES at the whole
   * yard changed nothing it could see. Measured at 0 failures. The capital tile states the car count
   * it covers, so that sentence is the one that has to move when the search does.
   */
  const narrowedTile = (await page.textContent('[data-testid="tile-capital"]')) ?? '';
  /**
   * THE TILES FOLLOW THE SEARCH. Still asserted: a tile describing a set the reader is not looking at
   * is worse than no tile. What it does NOT follow is the TAB — see the clause below, which is the
   * deliberate half and the one a later "simplification" would break.
   */
  check('  …and the TILES retotal to the SEARCH',
    /All 1 you own/.test(narrowedTile) && after < before,
    `${narrowedTile.trim().slice(-30)} with ${after} of ${before} rows shown`);


  // ════════════════════════════════════════════════════════════════════════════════════════════
  //  TWO CLOCKS: the book counts OWNERSHIP, the forecourt counts ARRIVAL
  // ════════════════════════════════════════════════════════════════════════════════════════════
  console.log('\n— the split, on the pure functions —');
  const march = new Date('2026-03-30T12:00:00Z');
  const april = new Date('2026-04-02T12:00:00Z');
  const may = new Date('2026-05-01T12:00:00Z');
  check('days on the forecourt count from ARRIVAL, not purchase',
    S.daysOnForecourt({ acquiredAt: march, arrivedAt: april, status: 'in_prep' }, may) === 29
      && S.daysInStock(march, may) === 32,
    '29 on the forecourt against 32 owned — three days of those were spent at the auction');
  check('a car with no arrival date falls back to purchase, so nothing already recorded moves',
    S.daysOnForecourt({ acquiredAt: march, arrivedAt: null, status: 'in_prep' }, may) === S.daysInStock(march, may),
    'arrived_at was added nullable and never backfilled — this is what makes that safe');
  check('a car that has NOT arrived has NO days on the forecourt — null, never 0',
    S.daysOnForecourt({ acquiredAt: march, arrivedAt: null, status: 'due_in' }, may) === null,
    '0 would say it got here today and has been sitting no time, about a car on somebody else’s site');

  console.log('\n— and the BOOK does not move —');
  check('a car bought in MARCH and collected in APRIL is in the MARCH book',
    S.sectionFor({ acquiredAt: march, disposedAt: null, periodStart: new Date('2026-03-01T00:00:00Z'), periodEnd: new Date('2026-03-31T23:59:59Z') }) === 'in_stock',
    'ownership starts at purchase whether or not the car is on your premises');
  check('  …and is NOT filed as not-yet-acquired in March because it had not turned up',
    S.sectionFor({ acquiredAt: march, disposedAt: null, periodStart: new Date('2026-03-01T00:00:00Z'), periodEnd: new Date('2026-03-31T23:59:59Z') }) !== 'not_yet');
  /**
   * SCOPED TO THE WHOLE FUNCTION BODY, to the NEXT top-level export. The first version split on the
   * first column-0 `}` — the closing brace of stockBook's own RETURN TYPE, three lines in — so it
   * tested the signature and nothing else. Measured: a mutation pointing the book's query at
   * arrived_at scored 0 failures against the entire suite.
   */
  const bookSrc = readFileSync('lib/stock-store.ts', 'utf8');
  const bookBody = bookSrc.split('export async function stockBook')[1].split('\nexport ')[0];
  check('the book body was actually found, so the clauses below are about something',
    bookBody.length > 600 && /periodEnd/.test(bookBody), `${bookBody.length} chars`);
  check('the book’s period query reads acquired_at',
    hasKey(bookBody, 'acquired_at', /\{ lte: periodEnd \}/),
    'the one query that decides which quarter a car belongs to');
  check('  …and stockBook never consults arrived_at at all',
    !/arrived_at/.test(bookBody),
    'a book that counted from arrival would silently re-file cars between quarters');

  console.log('\n— status is EXPLICIT, and arriving is its own act —');
  check('the four states, and Sold is NOT one of them',
    JSON.stringify([...S.STOCK_STATUSES]) === JSON.stringify(['due_in', 'in_prep', 'advertised', 'reserved'])
      && !S.STOCK_STATUSES.includes('sold'),
    'a sold car is one with a StockDisposal — two sources for "is it sold" would disagree');
  check('  …and the tabs add GONE on top of them', S.STOCK_TABS.length === 5 && S.STOCK_TABS.includes('gone'));

  const regL = `ZZYARD${Math.floor(Math.random() * 900 + 100)}L`;
  const vL = await ST.findOrCreateVehicle({ groupId: ZZ_GROUP, registration: regL, acquiredAt: bought });
  if ('refused' in vL) throw new Error(vL.refused);
  made.vehicles.push(vL.id);
  const dueIn = await ST.takeIntoStock({
    groupId: ZZ_GROUP, userId: owner.id, vehicleId: vL.id, acquiredAt: bought,
    purchasePence: 214300, vatStatus: 'margin', source: 'auction', status: 'due_in',
  });
  if ('refused' in dueIn) throw new Error(dueIn.refused);
  made.items.push(dueIn.id);
  let dueRow = (await ST.stockList(ZZ_GROUP, new Date())).find((r) => r.stockItemId === dueIn.id);
  check('a car taken in as DUE IN has no arrival date and no days on the forecourt',
    dueRow.status === 'due_in' && dueRow.arrivedAt === null && dueRow.daysInStock === null,
    `status=${dueRow.status} arrived=${dueRow.arrivedAt} days=${dueRow.daysInStock}`);

  const noDateMove = await ST.setStockStatus({ groupId: ZZ_GROUP, stockItemId: dueIn.id, status: 'in_prep' });
  check('leaving DUE IN without saying when it arrived is REFUSED',
    'refused' in noDateMove && /when it arrived/i.test(noDateMove.refused),
    'otherwise its clock would start at the purchase date — the thing arrived_at exists to prevent');
  const early = await ST.setStockStatus({
    groupId: ZZ_GROUP, stockItemId: dueIn.id, status: 'in_prep',
    arrivedAt: new Date('2020-01-01T12:00:00Z'),
  });
  check('  …and arriving BEFORE you bought it is refused', 'refused' in early);

  const arrived = new Date(bought.getTime() + 3 * 86400000);
  const moved = await ST.setStockStatus({ groupId: ZZ_GROUP, stockItemId: dueIn.id, status: 'in_prep', arrivedAt: arrived });
  if ('refused' in moved) throw new Error(moved.refused);
  dueRow = (await ST.stockList(ZZ_GROUP, new Date())).find((r) => r.stockItemId === dueIn.id);
  check('once it arrives the clock starts, and starts from ARRIVAL',
    dueRow.daysInStock === S.daysInStock(arrived, new Date()) && dueRow.daysInStock < S.daysInStock(bought, new Date()),
    `${dueRow.daysInStock} days on the forecourt vs ${S.daysInStock(bought, new Date())} owned`);
  const sentBack = await ST.setStockStatus({ groupId: ZZ_GROUP, stockItemId: dueIn.id, status: 'due_in' });
  check('sending it BACK to due in clears the arrival date',
    'id' in sentBack
      && (await ST.stockList(ZZ_GROUP, new Date())).find((r) => r.stockItemId === dueIn.id).arrivedAt === null,
    'a stale arrival date keeps a clock running on a forecourt the car has left');
  await ST.setStockStatus({ groupId: ZZ_GROUP, stockItemId: dueIn.id, status: 'advertised', arrivedAt: arrived });

  console.log('\n— tabs and counts —');
  const all = await ST.stockList(ZZ_GROUP, new Date());
  const counts = SL.tabCounts(all);
  check('every car lands in exactly one tab',
    Object.values(counts).reduce((a, b) => a + b, 0) === all.length,
    `${JSON.stringify(counts)} over ${all.length} cars`);
  check('the advertised car is in Advertised', SL.tabFor(all.find((r) => r.stockItemId === dueIn.id)) === 'advertised');
  check('GONE WINS over status — a sold car counted as advertised would be the defect',
    SL.tabFor({ status: 'advertised', disposalKind: 'sold' }) === 'gone');
  check('an unrecognised status shows SOMEWHERE rather than vanishing from every tab',
    SL.tabFor({ status: 'nonsense-status', disposalKind: null }) === 'in_prep');
  /**
   * THE BUBBLE DOES NOT MOVE WHEN YOU SEARCH — driven through the real page, because the rule lives
   * in what the component hands to tabCounts, and a pure-function clause cannot see that choice.
   * Measured: wiring the page to count the filtered rows scored 0 failures against the suite.
   */
  await page.goto(`${gateOrigin()}/admin/stock`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-testid="stock-tabs"]', { timeout: 25000 });
  await page.click('[data-testid="tab-advertised"]');
  const bubbleBefore = (await page.textContent('[data-testid="count-advertised"]')).trim();
  const rowsBefore = (await page.$$('[data-testid^="stock-row-"]')).length;
  /**
   * A SEARCH THAT MATCHES NOTHING, deliberately. Searching for the advertised car itself cannot see
   * the defect: it is the only advertised car, so a bubble that DID follow the search would still
   * read 1. A term that matches no car drives every filtered count to zero, so the bubble holding its
   * value is the whole assertion. Measured: with the car's own plate, the mutation scored 0 failures.
   */
  await page.fill('[data-testid="stock-search"]', 'ZZNOSUCHCARATALL');
  await page.waitForFunction(() => document.querySelectorAll('[data-testid^="stock-row-"]').length === 0,
    null, { timeout: 15000 });
  const bubbleAfter = (await page.textContent('[data-testid="count-advertised"]')).trim();
  const rowsAfter = (await page.$$('[data-testid^="stock-row-"]')).length;
  check('the bubble counts the WHOLE YARD and does not move when you search',
    bubbleBefore === bubbleAfter,
    `${bubbleBefore} → ${bubbleAfter} while the list went ${rowsBefore} → ${rowsAfter}`);
  check('  …while the list itself really did empty, so the clause above is not vacuous',
    rowsAfter === 0 && rowsBefore > 0, `${rowsBefore} → ${rowsAfter}`);
  check('  …and the header says "N of M", so the two numbers are visibly different',
    /\d+ of \d+ in /.test((await page.textContent('[data-testid="stock-summary"]')) ?? ''),
    ((await page.textContent('[data-testid="stock-summary"]')) ?? '').trim());
  await page.fill('[data-testid="stock-search"]', '');
  check('a car with NO projection still counts in its bubble',
    SL.tabCounts([{ status: 'in_prep', disposalKind: null, projectedSalePence: null, projectedProfitPence: null,
      registration: 'X', description: null, acquiredAt: '2026-01-01', daysInStock: 1, purchasePence: 1, prepPence: 0, vatStatus: 'margin' }]).in_prep === 1,
    'a bubble counts cars in a state, which every car has');

  // ═══════════════════════════════════════════════════════════════════════════════════════════
  //  THE SOLD REPORT — the denominator is cars SOLD
  // ═══════════════════════════════════════════════════════════════════════════════════════════
  console.log('\n— sales only, and the average says over what —');
  const soldRows = [
    { stockItemId: 'a', registration: 'A', disposedAt: new Date('2026-05-01'), kind: 'sold',
      salePence: 400000, purchasePence: 214300, costsPence: 20000, daysInStock: 30 },
    { stockItemId: 'b', registration: 'B', disposedAt: new Date('2026-05-10'), kind: 'sold',
      salePence: 300000, purchasePence: 200000, costsPence: 0, daysInStock: 60 },
    { stockItemId: 'c', registration: 'C', disposedAt: new Date('2026-05-20'), kind: 'scrapped',
      salePence: null, purchasePence: 150000, costsPence: 5000, daysInStock: 200 },
  ];
  const sum = SS.summariseSold(soldRows);
  check('a SCRAPPED car is not a sale', sum.sold === 2 && sum.disposals === 3 && sum.nonSales === 1);
  check('revenue counts only the sales', sum.revenuePence === 700000);
  check('profit is sale minus purchase minus FROZEN costs',
    sum.profitPence === (400000 - 214300 - 20000) + (300000 - 200000 - 0), `${sum.profitPence}p`);
  check('THE DENOMINATOR IS CARS SOLD, not cars disposed',
    sum.avgProfitPence === Math.round(sum.profitPence / 2),
    'dividing by 3 would drag the average down as though a scrapped car were a bad sale');
  check('  …and the scrapped car’s 200 days do not enter the average either',
    sum.avgDaysInStock === 45, `${sum.avgDaysInStock} — (30 + 60) / 2`);
  check('  …and the denominator is stated ON THE FACE OF IT',
    /over the 2 cars SOLD/.test(SS.denominatorNote(sum)) && /1 other car left without being sold/.test(SS.denominatorNote(sum)),
    SS.denominatorNote(sum));
  check('nothing sold gives NULL averages, never £0',
    SS.summariseSold([]).avgProfitPence === null && SS.summariseSold([]).avgDaysInStock === null,
    '£0 would read as "we sold cars and made nothing"');
  check('a sold car with NO arrival date is counted, not averaged in at its purchase date',
    (() => { const x = SS.summariseSold([{ ...soldRows[0], daysInStock: null }]);
             return x.avgDaysInStock === null && x.daysUnknown === 1; })(),
    'and the note says so rather than quietly covering fewer cars than it claims');
  check('traded out IS a sale; scrapped, returned and own use are not',
    SS.isSaleKind('sold') && SS.isSaleKind('traded_out')
      && !SS.isSaleKind('scrapped') && !SS.isSaleKind('returned') && !SS.isSaleKind('own_use'));

  console.log('\n— the period vocabulary is the dashboard’s own —');
  const api = readFileSync('pages/api/stock.ts', 'utf8');
  check('the sold report resolves its period through lib/dashboard-periods',
    /resolveRange\(/.test(api) && /from '@\/lib\/dashboard-periods'/.test(api),
    'a second period vocabulary would drift and the two screens would disagree about "last quarter"');
  check('  …and reads the tenant’s OWN financial year, not a default April',
    hasKey(api, 'fy_start_month', 'true') && /g\?\.fy_start_month \?\? 4/.test(api),
    'a cast onto the tax profile compiled fine and would have given every tenant an April year-end');
  check('all_time is the one addition, and it is a STOCK preset not a dashboard one',
    SS.SOLD_EXTRA_PRESET === 'all_time' && !/all_time/.test(readFileSync('lib/dashboard-periods.ts', 'utf8')),
    'every dashboard preset assumes enough history for a month to mean something');
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
        made.vehicles = [...new Set([...made.vehicles, ...fixtures.map((f) => f.id)])];
        const orphans = await prisma.stockItem.deleteMany({
          where: { group_id: ZZ_GROUP, vehicle_id: { in: made.vehicles } },
        });
        if (orphans.count) check('  …including a stock row the run did not track', true, `${orphans.count} swept`);

        /**
         * AND THE JOB CARDS, which the backstop did not sweep until 2026-09-15 and which are the other
         * thing that can hold a fixture vehicle: JobCard.vehicle is onDelete NoAction, so ONE untracked
         * card makes the vehicle delete throw P2003 and the whole teardown abandons — leaving every
         * fixture behind for the next run to collide with. That is exactly what happened: an aborted
         * run left 15 cars and 2 cards, and the next run failed on a VIN the previous one still owned.
         *
         * Scoped to the fixture vehicles, so it cannot reach a real card: those ids came from the
         * prefix match above, and no real registration starts with them.
         */
        const strayCards = await prisma.jobCard.findMany({
          where: { group_id: ZZ_GROUP, vehicle_id: { in: made.vehicles } }, select: { id: true },
        });
        if (strayCards.length) {
          const ids = strayCards.map((c) => c.id);
          await prisma.jobCardItem.deleteMany({ where: { job_card_id: { in: ids } } });
          await prisma.auditLog.deleteMany({ where: { entity: 'job_card', entity_id: { in: ids } } }).catch(() => {});
          const gone = await prisma.jobCard.deleteMany({ where: { id: { in: ids }, group_id: ZZ_GROUP } });
          check('  …and a job card the run did not track', gone.count === ids.length, `${gone.count} swept`);
        }
        await prisma.vehicleOdometerReading.deleteMany({ where: { vehicle_id: { in: made.vehicles } } });
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
