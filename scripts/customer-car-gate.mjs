/**
 * File: scripts/customer-car-gate.mjs
 * @gate-requires: db, server
 *
 * IS THIS A CUSTOMER'S CAR — and do the two ways of asking it agree?
 *
 * ── THE DEFECT ──────────────────────────────────────────────────────────────────────────────────
 * The marketing board read every Vehicle in the group as a customer's car, because it was written
 * before stock existed. Measured on the live tenant 2026-09-16: three of twelve Hot leads were the
 * garage's OWN cars with expired MOTs — the board was telling the owner to ring himself, and the
 * number a garage reads as "people worth ringing today" was wrong by a quarter. All five of that
 * tenant's stock cars carried an MOT date, so all five were eligible; two were absent only because
 * their MOTs happened to be fine. The diary had the same shape and was fixed separately.
 *
 * ── THE CLAUSE THAT IS THE WHOLE POINT ──────────────────────────────────────────────────────────
 * lib/customer-car exports the rule TWICE — `CUSTOMER_CARS` as a Prisma where fragment (so a fleet
 * read excludes at the query and never loads the rows) and `isCustomerCar` over rows in memory. Two
 * rules hoping
 * to stay in step is exactly what is being fixed, so the clause below does not check that each is
 * separately plausible: it runs BOTH over the same fixtures and asserts the two sets are IDENTICAL.
 * A fixture-coverage clause sits in front of it, so adding a disposal kind fails here until both
 * halves of the rule know about it.
 *
 * ── WHAT THIS GATE ALREADY CAUGHT ───────────────────────────────────────────────────────────────
 * The first version of the rule asked "is it OURS", and the board clauses went red on `scrapped` and
 * `returned`: a scrapped car is not ours and is not a customer's either, so the complement put it
 * back on the board. OURS AND A CUSTOMER'S ARE NOT COMPLEMENTS. The rule now asks the positive
 * question, and the clauses below keep every kind pinned to a stack or to none of them.
 *
 * FIXTURES ON ZZ ONLY, prefix ZZOURS, swept before and after.
 */
import './_gate-preflight.mjs';
const { gatePrisma, describeError, ZZ_GROUP, gateOrigin, serverReady } = await import('./_gate-preflight.mjs');
import './_ts.mjs';
const { chromium } = await import('/Users/hugh/Developer/greasedesk-core/node_modules/playwright-core/index.mjs');
const { readFileSync } = await import('node:fs');
const { hasKey } = await import('/Users/hugh/Developer/greasedesk-core/lib/anchored-match.ts');

const out = [];
const check = (n, ok, d = '') => { out.push(ok ? 'P' : 'F'); console.log(`${ok ? '✓' : '✗'} ${n}${d ? `  — ${d}` : ''}`); };
const PREFIX = 'ZZOURS';

const { isCustomerCar, CUSTOMER_CARS, LEAD_AGAIN_KINDS, FLEET_EXCLUDES_STOCK } =
  await import('/Users/hugh/Developer/greasedesk-core/lib/customer-car.ts');
const { DISPOSAL_KINDS } = await import('/Users/hugh/Developer/greasedesk-core/lib/stock.ts');
const src = (f) => readFileSync(`/Users/hugh/Developer/greasedesk-core/${f}`, 'utf8');

let prisma;
let browser = null;
try {
  console.log('— THE RULE, OVER ROWS IN MEMORY —');
  const only = (d) => ({ stockItems: [d === undefined ? { disposal: null } : { disposal: { kind: d } }] });
  check('a car we have never owned IS a customer\'s car', isCustomerCar({ stockItems: [] }) === true);
  check('  …and so is a car with no stockItems field at all', isCustomerCar({}) === true,
    'absence must mean "a customer\'s car" — it is the overwhelming majority');
  check('a car in the yard right now is NOT', isCustomerCar(only(undefined)) === false);
  /**
   * THE TRAP. own_use is a disposal — the car leaves the BOOK — but it does not leave the owner's
   * hands. A rule that looked only for an open stock item would put the car moved from the yard to
   * the drive straight back on the board, telling him to ring himself again.
   */
  check('own_use is a DISPOSAL and the car is STILL not a customer\'s',
    isCustomerCar(only('own_use')) === false,
    'the same bug deferred by one action, if this is ever "simplified" away');
  check('scrapped is not a customer\'s car — there is no car', isCustomerCar(only('scrapped')) === false);
  /**
   * RULED 2026-09-16, and the one a later reader will want to "fix": returned means returned to the
   * SELLER, so somebody else owns it and it looks like it qualifies. Whether another party owns a car
   * is not the question — whether they are someone this garage would ring about an MOT is, and a
   * trade vendor is not.
   */
  check('returned is GONE, like scrapped, and NOT a lead', isCustomerCar(only('returned')) === false,
    'not a lead on the grounds that someone else owns it — that reasoning is the trap');
  check('a car we SOLD is a customer\'s car again', isCustomerCar(only('sold')) === true);
  check('  …and so is one traded out', isCustomerCar(only('traded_out')) === true);
  check('  …and those two are the only kinds that hand it back',
    JSON.stringify([...LEAD_AGAIN_KINDS]) === JSON.stringify(['sold', 'traded_out']), [...LEAD_AGAIN_KINDS].join(','));
  /** A RE-ACQUISITION IS A NEW ROW, NEVER AN UNDO, so a car can carry several items. */
  check('a car sold and then bought back is ours again, whatever the earlier sale says',
    isCustomerCar({ stockItems: [{ disposal: { kind: 'sold' } }, { disposal: null }] }) === false);
  check('  …and one sold twice with nothing open is a customer\'s',
    isCustomerCar({ stockItems: [{ disposal: { kind: 'sold' } }, { disposal: { kind: 'sold' } }] }) === true);
  check('  …while one sold and later SCRAPPED by us is not',
    isCustomerCar({ stockItems: [{ disposal: { kind: 'sold' } }, { disposal: { kind: 'scrapped' } }] }) === false);

  prisma = await gatePrisma();
  const sweep = async () => {
    const vs = await prisma.vehicle.findMany({ where: { group_id: ZZ_GROUP, registration: { startsWith: PREFIX } }, select: { id: true } });
    const ids = vs.map((v) => v.id);
    if (!ids.length) return 0;
    const its = await prisma.stockItem.findMany({ where: { vehicle_id: { in: ids } }, select: { id: true } });
    await prisma.stockDisposal.deleteMany({ where: { stock_item_id: { in: its.map((i) => i.id) } } });
    await prisma.stockItem.deleteMany({ where: { vehicle_id: { in: ids } } });
    // JobCard.vehicle is onDelete NoAction: one stray card makes the vehicle delete throw P2003 and
    // abandon the whole teardown.
    await prisma.jobCard.deleteMany({ where: { group_id: ZZ_GROUP, vehicle_id: { in: ids } } });
    return (await prisma.vehicle.deleteMany({ where: { id: { in: ids } } })).count;
  };
  const beforeN = await sweep();
  if (beforeN) console.log(`\n  (swept ${beforeN} fixture vehicle(s) left by an earlier run)`);

  const user = await prisma.user.findFirst({ where: { group_id: ZZ_GROUP }, select: { id: true } });
  const past = new Date(Date.now() - 40 * 86_400_000); // an MOT 40 days out of date: a Hot lead
  const mk = async (suffix) => prisma.vehicle.create({
    data: { group_id: ZZ_GROUP, registration: `${PREFIX}${suffix}`, registration_normalized: `${PREFIX}${suffix}`,
      make: 'ZZ', model: 'Ours', year: 2014, mot_expiry: past, mot_checked_at: new Date() },
    select: { id: true, registration: true },
  });
  const stock = async (vehicleId, kind) => {
    const it = await prisma.stockItem.create({
      data: { group_id: ZZ_GROUP, vehicle_id: vehicleId, acquired_at: new Date('2026-01-05'), status: 'in_prep',
        purchase_pence: 500000, vat_status: 'margin', source: 'auction', created_by_user_id: user.id },
      select: { id: true },
    });
    if (kind) await prisma.stockDisposal.create({ data: {
      group_id: ZZ_GROUP, stock_item_id: it.id, disposed_at: new Date('2026-06-01'), kind, created_by_user_id: user.id } });
    return it.id;
  };

  // ONE FIXTURE PER DISPOSAL KIND, plus never-stock, plus open, plus the re-acquisition shape.
  const fixtures = {};
  fixtures.NEVER = await mk('NEVER');                                  // never stock — a customer's car
  fixtures.OPEN = await mk('OPEN'); await stock(fixtures.OPEN.id, null);
  for (const kind of DISPOSAL_KINDS) {
    const v = await mk(kind.toUpperCase().replace('_', '').slice(0, 6));
    await stock(v.id, kind);
    fixtures[kind] = v;
  }
  fixtures.BACK = await mk('BACK');                                    // sold, then bought back
  await stock(fixtures.BACK.id, 'sold'); await stock(fixtures.BACK.id, null);

  console.log('\n— THE FIXTURES COVER EVERY KIND THAT EXISTS —');
  const covered = DISPOSAL_KINDS.every((k) => fixtures[k]);
  check('every disposal kind in lib/stock has a fixture', covered,
    `${DISPOSAL_KINDS.join(', ')} — add a kind and this fails until both halves of the rule know about it`);

  /**
   * ═══ THE CLAUSE THIS GATE EXISTS FOR ═══════════════════════════════════════════════════════════
   * Not "the query looks right" and not "the predicate looks right" — the two answers, over the same
   * rows, must be the SAME SET.
   */
  console.log('\n— AND THE TWO EXPORTS AGREE, OVER THE SAME ROWS —');
  const ids = Object.values(fixtures).map((v) => v.id);
  const byQuery = await prisma.vehicle.findMany({
    where: { group_id: ZZ_GROUP, id: { in: ids }, ...CUSTOMER_CARS }, select: { id: true, registration: true },
  });
  const loaded = await prisma.vehicle.findMany({
    where: { group_id: ZZ_GROUP, id: { in: ids } },
    select: { id: true, registration: true, stockItems: { select: { disposal: { select: { kind: true } } } } },
  });
  const inMemory = loaded.filter((v) => isCustomerCar(v));
  const setQ = [...byQuery.map((v) => v.registration)].sort();
  const setM = [...inMemory.map((v) => v.registration)].sort();
  check('CUSTOMER_CARS (the query) and isCustomerCar (the predicate) select exactly the same cars',
    JSON.stringify(setQ) === JSON.stringify(setM),
    `query=[${setQ.join(' ')}]  predicate=[${setM.join(' ')}]`);
  const expected = ['NEVER', ...LEAD_AGAIN_KINDS].map((k) => fixtures[k].registration).sort();
  check('  …and that set is exactly the one the ruling names', JSON.stringify(setQ) === JSON.stringify(expected),
    `got [${setQ.join(' ')}], ruling says [${expected.join(' ')}]`);
  check('  …with in-stock, own_use, scrapped, returned and bought-back ALL held back',
    ['OPEN', 'own_use', 'scrapped', 'returned', 'BACK'].every((k) => !setQ.includes(fixtures[k].registration)));

  console.log('\n— ON THE BOARD ITSELF —');
  const { buildBoard } = await import('/Users/hugh/Developer/greasedesk-core/lib/marketing-board.ts');
  const board = await buildBoard(ZZ_GROUP, new Date());
  const onBoard = (reg) => ['hot', 'warm', 'later'].some((k) => (board[k] ?? []).some((r) => r.registration === reg));
  check('a car WE OWN with an expired MOT is on no stack at all', !onBoard(fixtures.OPEN.registration),
    'in any bucket, and counting toward none of them');
  check('  …nor is the one taken into own use', !onBoard(fixtures.own_use.registration));
  check('  …nor the one returned to the seller — GONE, like scrapped', !onBoard(fixtures.returned.registration),
    'it has an owner, and that is not what makes a lead');
  check('  …nor the one scrapped', !onBoard(fixtures.scrapped.registration));
  check('  …nor the one sold and then bought back', !onBoard(fixtures.BACK.registration));
  check('a car we SOLD is a lead again — it has a new keeper', onBoard(fixtures.sold.registration),
    'the exclusion must not be a permanent blacklist');
  check('  …and so is one traded out', onBoard(fixtures.traded_out.registration));
  check('  …while a car never in stock is unaffected', onBoard(fixtures.NEVER.registration));

  console.log('\n— AND OUT OF THE DENOMINATOR TOO —');
  const rawFleet = await prisma.vehicle.count({ where: { group_id: ZZ_GROUP } });
  const notCustomers = loaded.filter((v) => !isCustomerCar(v)).length;
  check('board.fleet is smaller than the raw vehicle count by exactly the non-customer cars',
    board.fleet === rawFleet - notCustomers, `fleet=${board.fleet}, raw=${rawFleet}, excluded=${notCustomers}`);

  const ready = await serverReady();
  check('the dev server serves pages before we drive it', ready.ok, `HTTP ${ready.status}`);
  const origin = gateOrigin();
  browser = await chromium.launch({ channel: 'chrome' });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  await page.goto(`${origin}/admin/login`, { waitUntil: 'domcontentloaded' });
  await page.fill('input[type="email"]', 'owner@zzgategarage.test');
  await page.fill('input[type="password"]', 'GateGarage!2026');
  await Promise.all([page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 60000 }), page.click('button[type="submit"]')]);
  await page.goto(`${origin}/admin/marketing`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-testid="fleet-count"]', { timeout: 25000 });
  const shown = await page.evaluate(() => ({
    fleet: document.querySelector('[data-testid="fleet-count"]')?.textContent ?? '',
    note: document.querySelector('[data-testid="fleet-excludes-stock"]')?.textContent ?? '',
    noteVisible: !!document.querySelector('[data-testid="fleet-excludes-stock"]')?.offsetParent,
    ours: [...document.body.querySelectorAll('*')].some((e) => e.childElementCount === 0 && /ZZOURSOPEN/.test(e.textContent || '')),
  }));
  check('the page renders the reduced fleet figure', shown.fleet.includes(String(board.fleet)), shown.fleet.trim());
  /** A DENOMINATOR THAT COUNTS CARS THE NUMERATOR CANNOT is arithmetic that stops adding up. */
  check('  …and SAYS on the tile that our own cars are not in it',
    shown.note.trim() === FLEET_EXCLUDES_STOCK && shown.noteVisible, shown.note.trim());
  check('  …and the car we own appears nowhere on the rendered page', !shown.ours,
    'the board is one row per car, so a stock car leaking into any stack shows here');

  console.log('\n— THE DEAD LISTS ARE GONE, AND NOTHING READS THE FLEET WITHOUT THE RULE —');
  /**
   * STRIP THE COMMENTS FIRST. lib/marketing-data's header NAMES both deleted functions on purpose —
   * that is the record of what they were and what replaced them — so a raw scan matches the very
   * note that documents the removal and can never fail. (The first version of this clause used
   * hasKey, which matches key/path shapes and not a function declaration: it could not fail either,
   * and the red-proof caught it rather than the gate.)
   */
  const code = (f) => src(f).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const DEAD = ['buildMotList', 'buildServiceList'];
  const SCAN = ['lib/marketing-data.ts', 'lib/marketing-board.ts', 'lib/marketing-lists.ts',
    'pages/admin/marketing.tsx', 'pages/api/marketing/unactioned.ts'];
  const revived = SCAN.flatMap((f) => DEAD.filter((d) => new RegExp(`\\b${d}\\b`).test(code(f))).map((d) => `${d} in ${f}`));
  check('the two dead lists are gone, in code and not merely in comments', revived.length === 0,
    revived.length ? revived.join(', ') : 'kept CORRECT while dead for three weeks — the next person would have revived the same defect');
  check('  …and the header still records what they were, so the removal is not silent',
    DEAD.every((d) => src('lib/marketing-data.ts').includes(d)),
    'named in the comment, absent from the code — deleting the note would lose why');
  const files = ['lib/marketing-board.ts', 'lib/marketing-data.ts', 'lib/marketing-lists.ts', 'pages/admin/marketing.tsx'];
  const stray = files.filter((f) => /prisma\.vehicle\.(findMany|count)/.test(src(f)) && !src(f).includes('CUSTOMER_CARS'));
  check('every fleet-wide Vehicle read on this surface carries CUSTOMER_CARS', stray.length === 0,
    stray.length ? stray.join(', ') : 'board only, both reads');

} catch (e) {
  check('run completed', false, describeError(e).slice(0, 300));
} finally {
  await browser?.close().catch(() => {});
  if (prisma) {
    try {
      const vs = await prisma.vehicle.findMany({ where: { group_id: ZZ_GROUP, registration: { startsWith: PREFIX } }, select: { id: true } });
      const ids = vs.map((v) => v.id);
      if (ids.length) {
        const its = await prisma.stockItem.findMany({ where: { vehicle_id: { in: ids } }, select: { id: true } });
        await prisma.stockDisposal.deleteMany({ where: { stock_item_id: { in: its.map((i) => i.id) } } });
        await prisma.stockItem.deleteMany({ where: { vehicle_id: { in: ids } } });
        await prisma.jobCard.deleteMany({ where: { group_id: ZZ_GROUP, vehicle_id: { in: ids } } });
        await prisma.vehicle.deleteMany({ where: { id: { in: ids } } });
      }
      const left = await prisma.vehicle.count({ where: { group_id: ZZ_GROUP, registration: { startsWith: PREFIX } } });
      check('teardown left ZZ with none of this gate’s vehicles', left === 0, `${ids.length} removed, ${left} left`);
    } catch (e) { check('teardown completed', false, describeError(e).slice(0, 200)); }
  }
}
console.log(`\n${out.filter((c) => c === 'F').length} failures of ${out.length}`);
await prisma?.$disconnect();
process.exit(out.includes('F') ? 1 : 0);
