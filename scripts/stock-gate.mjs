/**
 * File: scripts/stock-gate.mjs
 * @gate-requires: db
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

const out = [];
const check = (n, ok, d = '') => { out.push(ok ? 'P' : 'F'); console.log(`${ok ? '✓' : '✗'} ${n}${d ? `  — ${d}` : ''}`); };
const gbp = (p) => `£${(p / 100).toFixed(2)}`;

let prisma;
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
} catch (e) {
  check('run completed', false, describeError(e).slice(0, 300));
} finally {
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
        const orphans = await prisma.stockItem.deleteMany({
          where: { group_id: ZZ_GROUP, vehicle_id: { in: made.vehicles } },
        });
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
