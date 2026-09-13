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
const { readFileSync } = await import('node:fs');
const { gateOrigin, serverReady } = await import('./_gate-preflight.mjs');
const { chromium } = await import('/Users/hugh/Developer/greasedesk-core/node_modules/playwright-core/index.mjs');

const out = [];
const check = (n, ok, d = '') => { out.push(ok ? 'P' : 'F'); console.log(`${ok ? '✓' : '✗'} ${n}${d ? `  — ${d}` : ''}`); };
const gbp = (p) => `£${(p / 100).toFixed(2)}`;

let prisma;
let browser = null;
let made = { items: [], vehicles: [] };
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

} catch (e) {
  check('run completed', false, describeError(e).slice(0, 300));
} finally {
  await browser?.close().catch(() => {});
  if (prisma) {
    try {
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
          where: { group_id: ZZ_GROUP, OR: ['ZZSTK', 'ZZYARD', 'ZZNODATE'].map((x) => ({ registration: { startsWith: x } })) },
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
