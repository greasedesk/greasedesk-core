/**
 * File: scripts/catalogue-sets-gate.mjs
 * @gate-requires: db, server
 *
 * CATALOGUE SETS AND THE FOURTH TIER STATE.
 *
 * ── THE DEFECT THIS EXISTS FOR ──────────────────────────────────────────────────────────────────
 * A tier price had three states and needed four. An electric car cannot have an oil service, and
 * the catalogue could say so in exactly two wrong ways: type 0, which PRINTS AS FREE on a
 * customer's quote, or leave it blank, which falls through to the base price and offers it at full
 * whack. Neither is "not applicable", and nothing in the system could tell the difference.
 *
 * ── AND WHY THE SETS ARE HERE TOO ───────────────────────────────────────────────────────────────
 * An option can only hold lines already on the estimate, so "offer alternatives" on Bronze could
 * only ever offer Bronze again — Silver, Gold and Platinum are catalogue rows the builder cannot
 * reach. The sets are what make the ladder possible, and `shape` reuses GROUP_SHAPES rather than
 * inventing a second vocabulary for the same question.
 *
 * FIXTURES ON ZZ ONLY, by this gate's own prefix, swept before and after and REGISTERED with
 * onTeardown so the runner's cap cannot leave them behind.
 */
import './_gate-preflight.mjs';
const { gatePrisma, describeError, ZZ_GROUP, onTeardown, gateOrigin, serverReady } = await import('./_gate-preflight.mjs');
import './_ts.mjs';

const out = [];
const check = (n, ok, d = '') => { out.push(ok ? 'P' : 'F'); console.log(`${ok ? '✓' : '✗'} ${n}${d ? `  — ${d}` : ''}`); };
const R = '/Users/hugh/Developer/greasedesk-core';
const { chromium } = await import('/Users/hugh/Developer/greasedesk-core/node_modules/playwright-core/index.mjs');
const CAT = await import(`${R}/lib/catalogue.ts`);
const CS = await import(`${R}/lib/catalogue-sets.ts`);
const QO = await import(`${R}/lib/quote-options.ts`);
const PREFIX = 'ZZCS-';
const CAR = 'ZZCS1';

let prisma;
let browser = null;
const sweep = async () => {
  if (!prisma) return 0;
  await prisma.catalogueSetMember.deleteMany({ where: { group_id: ZZ_GROUP, set: { name: { startsWith: PREFIX } } } }).catch(() => {});
  await prisma.catalogueSet.deleteMany({ where: { group_id: ZZ_GROUP, name: { startsWith: PREFIX } } }).catch(() => {});
  const cards = (await prisma.jobCard.findMany({ where: { group_id: ZZ_GROUP, vehicle: { registration: CAR } }, select: { id: true } })).map((c) => c.id);
  if (cards.length) {
    await prisma.quoteOptionDraft.deleteMany({ where: { job_card_id: { in: cards } } }).catch(() => {});
    await prisma.quoteOptionGroupDraft.deleteMany({ where: { job_card_id: { in: cards } } }).catch(() => {});
    await prisma.jobCardItem.deleteMany({ where: { job_card_id: { in: cards } } });
    await prisma.jobCard.deleteMany({ where: { id: { in: cards } } });
  }
  await prisma.vehicle.deleteMany({ where: { group_id: ZZ_GROUP, registration: CAR } }).catch(() => {});
  await prisma.customer.deleteMany({ where: { group_id: ZZ_GROUP, name: `${PREFIX}customer` } }).catch(() => {});
  await prisma.serviceTier.deleteMany({ where: { group_id: ZZ_GROUP, name: { startsWith: PREFIX } } }).catch(() => {});
  return (await prisma.catalogueItem.deleteMany({ where: { group_id: ZZ_GROUP, code: { startsWith: PREFIX } } })).count;
};

try {
  prisma = await gatePrisma();
  onTeardown(sweep);
  await sweep();

  // ── 1. THE LOCAL UNION IS THE DATABASE'S ENUM ────────────────────────────────────────────────
  // lib/catalogue hand-writes the availability values because it is imported by a CLIENT component
  // and a value import from @prisma/client at module scope is how this codebase has shipped lib/db
  // to the browser before. A hand-written copy drifts silently; this clause is the thing that makes
  // the duplication safe, and without it the comment claiming so is a promise nobody keeps.
  console.log('— the copy and the original —');
  const { Prisma: P } = await import('@prisma/client');
  const dbEnum = P.dmmf.datamodel.enums.find((e) => e.name === 'TierAvailability');
  check('the schema still HAS a TierAvailability enum', !!dbEnum, dbEnum ? 'found' : 'the enum is gone — the union below describes nothing');
  check('lib/catalogue names exactly the database’s values, in the same set',
    !!dbEnum && JSON.stringify([...CAT.TIER_AVAILABILITIES].sort()) === JSON.stringify(dbEnum.values.map((v) => v.name).sort()),
    `${JSON.stringify([...CAT.TIER_AVAILABILITIES])} vs ${JSON.stringify((dbEnum?.values ?? []).map((v) => v.name))}`);

  // ── 2. FOUR STATES, AND THE RESOLVER SAYS WHICH ──────────────────────────────────────────────
  console.log('\n— a tier price in four states —');
  const T = 'tier-1';
  const row = (availability, priceExVat = null) => [{ tierId: T, priceExVat, availability }];
  check('no row for the tier inherits the base price',
    JSON.stringify(CAT.resolveTierPrice(120, [], T)) === JSON.stringify({ state: 'base', pricePounds: 120 }));
  check('no tier CHOSEN also inherits, even when rows exist',
    JSON.stringify(CAT.resolveTierPrice(120, row('priced', 90), null)) === JSON.stringify({ state: 'base', pricePounds: 120 }));
  check('a priced row is that price',
    JSON.stringify(CAT.resolveTierPrice(120, row('priced', 90), T)) === JSON.stringify({ state: 'priced', pricePounds: 90 }));
  check('  …and ZERO is a price, not an absence',
    JSON.stringify(CAT.resolveTierPrice(120, row('priced', 0), T)) === JSON.stringify({ state: 'priced', pricePounds: 0 }),
    'a legitimately free service, the same null/zero discipline as unit_cost');
  check('a per_job row carries NO price', JSON.stringify(CAT.resolveTierPrice(120, row('per_job'), T)) === JSON.stringify({ state: 'per_job' }));
  check('a not_applicable row carries NO price either',
    JSON.stringify(CAT.resolveTierPrice(120, row('not_applicable'), T)) === JSON.stringify({ state: 'not_applicable' }));

  // THE DISCRIMINATOR. Both refusals are priceless; only one is OFFERED. Without this the two
  // clauses above pass against a resolver that collapses them, which is the defect itself.
  check('…and the two priceless states are NOT the same answer',
    CAT.tierOffers(CAT.resolveTierPrice(120, row('per_job'), T)) === true
      && CAT.tierOffers(CAT.resolveTierPrice(120, row('not_applicable'), T)) === false,
    'per_job is offered and priced later; not_applicable is not offered at all');
  check('tierPricePounds gives null for both, so a careless caller gets a BLANK not a number',
    CAT.tierPricePounds(CAT.resolveTierPrice(120, row('per_job'), T)) === null
      && CAT.tierPricePounds(CAT.resolveTierPrice(120, row('not_applicable'), T)) === null);

  // A ROW WRITTEN BEFORE THE COLUMN reads the way it always did. The migration backfilled stored
  // rows to exactly this, so the fallback is for an un-regenerated client, never for live data.
  check('a row with no availability still reads as it always did',
    JSON.stringify(CAT.resolveTierPrice(120, [{ tierId: T, priceExVat: 90 }], T)) === JSON.stringify({ state: 'priced', pricePounds: 90 })
      && JSON.stringify(CAT.resolveTierPrice(120, [{ tierId: T, priceExVat: null }], T)) === JSON.stringify({ state: 'per_job' }));

  // ── 3. THE BACKFILL SAID THE SAME THING ABOUT THE LIVE ROWS ──────────────────────────────────
  // Not a tautology against the UPDATE: it reads the rows NOW and asserts the invariant the CHECK
  // will enforce, which is the thing that must be true before that migration can land at all.
  console.log('\n— and the rows that were already there —');
  const live = await prisma.$queryRawUnsafe(`
    SELECT availability::text AS a, COUNT(*)::int AS n,
           SUM(CASE WHEN price_ex_vat IS NULL THEN 1 ELSE 0 END)::int AS nulls
      FROM "CatalogueItemTierPrice" GROUP BY 1`);
  const byState = Object.fromEntries(live.map((r) => [r.a, r]));
  check('every priced row HAS a price', (byState.priced?.nulls ?? 0) === 0, JSON.stringify(live));
  check('every per_job row has NONE', (byState.per_job?.n ?? 0) === (byState.per_job?.nulls ?? 0), JSON.stringify(byState.per_job ?? {}));
  check('  …and so does every not_applicable row', (byState.not_applicable?.n ?? 0) === (byState.not_applicable?.nulls ?? 0),
    'this is the invariant the held-back CHECK will enforce; it must already hold');

  // ── 4. THE SET'S SHAPE IS THE QUOTE'S VOCABULARY ─────────────────────────────────────────────
  console.log('\n— one vocabulary, not two —');
  check('GROUP_SHAPES still has exactly the two shapes a set can take',
    JSON.stringify([...QO.GROUP_SHAPES].sort()) === JSON.stringify(['base_plus_extras', 'pick_one']),
    [...QO.GROUP_SHAPES].join(','));
  const bad = await prisma.$executeRawUnsafe(
    `INSERT INTO "CatalogueSet" (id,group_id,name,shape,position,active,created_at,updated_at)
     VALUES (gen_random_uuid(),$1,$2,'ladder',0,true,now(),now())`, ZZ_GROUP, `${PREFIX}bad shape`).then(() => 'ACCEPTED').catch((e) => String(e.message).slice(0, 60));
  check('the database refuses a shape outside that vocabulary', bad !== 'ACCEPTED',
    bad === 'ACCEPTED' ? 'a typo would read as "not a ladder" to the one-ladder trigger' : 'refused');

  // ── 5. AT MOST ONE LADDER PER ITEM, IN THE DATABASE ──────────────────────────────────────────
  console.log('\n— an item can be in one ladder —');
  const mkItem = async (code) => (await prisma.catalogueItem.create({ data: {
    group_id: ZZ_GROUP, code: `${PREFIX}${code}`, name: `${PREFIX}${code}`, title: `${PREFIX}${code}`,
    item_type: 'fixed', unit_price: 100, vat_rate: 20, base_price_ex_vat: 100 }, select: { id: true } })).id;
  const mkSet = async (name, shape) => (await prisma.catalogueSet.create({
    data: { group_id: ZZ_GROUP, name: `${PREFIX}${name}`, shape }, select: { id: true } })).id;
  const bronze = await mkItem('bronze');
  const ladderA = await mkSet('ladder A', 'pick_one');
  const ladderB = await mkSet('ladder B', 'pick_one');
  const menu = await mkSet('menu', 'base_plus_extras');
  const join = (setId, itemId, position = 0) => prisma.catalogueSetMember.create({
    data: { group_id: ZZ_GROUP, set_id: setId, catalogue_item_id: itemId, position } });

  check('an item joins a ladder', !!(await join(ladderA, bronze).then(() => true).catch(() => false)));
  check('  …and the SAME item joins a menu as well, which is allowed',
    !!(await join(menu, bronze).then(() => true).catch((e) => { console.log(`    (${String(e.message).slice(0, 80)})`); return false; })),
    'MOT belongs in more than one menu; only ladders are exclusive');
  const second = await join(ladderB, bronze).then(() => 'ACCEPTED').catch((e) => String(e.message));
  check('a SECOND ladder is refused by the database', second !== 'ACCEPTED',
    second === 'ACCEPTED' ? 'the builder could not say which ladder to offer' : 'refused');

  // THE OTHER WAY IN, which writes no member row at all and which a member-only trigger misses.
  const reshape = await prisma.catalogueSet.update({ where: { id: menu }, data: { shape: 'pick_one' } })
    .then(() => 'ACCEPTED').catch((e) => String(e.message));
  check('…and so is RE-SHAPING the menu it is already in into a ladder', reshape !== 'ACCEPTED',
    reshape === 'ACCEPTED' ? 'a member-only guard has a hole exactly here' : 'refused');
  check('  …and the menu is still a menu afterwards',
    (await prisma.catalogueSet.findUnique({ where: { id: menu }, select: { shape: true } }))?.shape === 'base_plus_extras');

  // ── 5b. WHAT A SET OFFERS A PARTICULAR CAR ──────────────────────────────────────────────────
  // rungsFor is where a wrong answer becomes a PRICE ON A CUSTOMER'S QUOTE, so each state gets its
  // own clause rather than one clause over a mixed list.
  console.log('\n— the rungs a set offers —');
  const TIER = 'tier-ev';
  const member = (id, position, basePriceExVat, availability) => ({
    catalogueItemId: id, position, title: id, basePriceExVat, vatRate: 20, labourHours: null,
    tierPrices: availability === undefined ? [] : [{ tierId: TIER, priceExVat: availability === 'priced' ? basePriceExVat - 10 : null, availability }],
  });
  const ladderMembers = [
    member('bronze', 0, 99), member('silver', 1, 139), member('gold', 2, 189), member('platinum', 3, 249),
  ];
  const noTier = CS.rungsFor(ladderMembers, null);
  check('with no tier chosen every rung is offered, at its base price',
    JSON.stringify(noTier.map((r) => [r.catalogueItemId, r.pricePounds]))
      === JSON.stringify([['bronze', 99], ['silver', 139], ['gold', 189], ['platinum', 249]]),
    JSON.stringify(noTier.map((r) => `${r.catalogueItemId}:${r.pricePounds}`)));
  check('  …in the SET’s order, not the order they were handed over',
    JSON.stringify(CS.rungsFor([ladderMembers[3], ladderMembers[0], ladderMembers[2], ladderMembers[1]], null).map((r) => r.catalogueItemId))
      === JSON.stringify(['bronze', 'silver', 'gold', 'platinum']),
    'position decides, and ties break on id so two rungs sharing one cannot swap between reads');

  // THE CLAUSE THIS WHOLE FEATURE TURNS ON. An electric car meeting an oil ladder must be offered
  // FEWER rungs, not a rung priced at nothing. Getting this wrong is the original defect wearing
  // a new coat: a plausible price on a quote for work the car cannot have.
  const evMembers = [
    member('bronze', 0, 99, 'not_applicable'),
    member('silver', 1, 139, 'priced'),
    member('gold', 2, 189, 'per_job'),
    member('platinum', 3, 249, 'not_applicable'),
  ];
  const ev = CS.rungsFor(evMembers, TIER);
  check('a not_applicable rung is ABSENT from the offer, not priced and not blank',
    ev.length === 2 && !ev.some((r) => r.catalogueItemId === 'bronze' || r.catalogueItemId === 'platinum'),
    `offered: ${ev.map((r) => r.catalogueItemId).join(',') || '(none)'} — expected silver,gold`);
  check('  …while a per_job rung IS offered, carrying no price',
    ev.some((r) => r.catalogueItemId === 'gold' && r.pricePounds === null),
    'priceless and withdrawn are different answers; dropping both would hide half the ladder');
  check('  …and a priced rung uses the TIER price, not the base price',
    ev.some((r) => r.catalogueItemId === 'silver' && r.pricePounds === 129),
    JSON.stringify(ev.map((r) => `${r.catalogueItemId}:${r.pricePounds}`)));
  check('every rung is offered, INCLUDING the ones below the line you dropped on',
    CS.rungsFor(ladderMembers, null).some((r) => r.catalogueItemId === 'bronze'),
    'a customer moving down from Gold to Silver is still a sale');

  console.log('\n— and which set a line can reach —');
  const sets = [
    { id: 'L', shape: 'pick_one', members: ladderMembers },
    { id: 'M1', shape: 'base_plus_extras', members: [member('mot', 0, 54)] },
    { id: 'M2', shape: 'base_plus_extras', members: [member('mot', 0, 54)] },
  ];
  check('a line whose product is in a ladder finds it', CS.ladderForItem(sets, 'gold')?.id === 'L');
  check('  …and a product that is only in MENUS finds no ladder', CS.ladderForItem(sets, 'mot') === null,
    'otherwise the extras icon and the alternatives icon would offer the same thing');
  check('  …and a hand-typed line, with no product at all, finds none', CS.ladderForItem(sets, null) === null);
  check('a product in two menus finds BOTH', CS.menusForItem(sets, 'mot').length === 2,
    'ladders are exclusive; menus are not, and MOT belongs in more than one');

  // ── 5c. THE LADDER ICON, ON THE SCREEN THAT HAS IT ──────────────────────────────────────────
  // Everything above is a pure function and a database constraint. NEITHER proves the estimator
  // can reach any of it: the whole point of sets is that an option could only ever hold work
  // already typed on the estimate, and that is a property of the BUILDER. So this drops the icon
  // on a real card and reads what landed in the database afterwards.
  console.log('\n— and the icon that reaches them —');
  const ready = await serverReady();
  check('the dev server serves pages before we drive it', ready.ok, `HTTP ${ready.status} after ${ready.attempts} attempt(s)`);

  const RUNGS = [['bronze', 'Bronze oil service', 99], ['silver', 'Silver oil service', 139],
                 ['gold', 'Gold oil service', 189], ['platinum', 'Platinum oil service', 249]];
  const itemId = {};
  for (const [code, title, price] of RUNGS) {
    itemId[code] = (await prisma.catalogueItem.create({ data: {
      // `r-` so these cannot collide with section 5's own bronze — the unique is (group, code),
      // and two sections of one gate sharing a fixture name is the same hazard as two gates doing it.
      group_id: ZZ_GROUP, code: `${PREFIX}r-${code}`, name: title, title, item_type: 'fixed',
      unit_price: price, vat_rate: 20, base_price_ex_vat: price }, select: { id: true } })).id;
  }
  const oilSet = await mkSet('Oil Services', 'pick_one');
  let p0 = 0;
  for (const [code] of RUNGS) await join(oilSet, itemId[code], p0++);

  // AN ELECTRIC TIER THAT WITHDRAWS A RUNG. This is the end-to-end form of the clause above: the
  // pure function drops it, and here we assert the SCREEN never offers it either.
  const evTier = await prisma.serviceTier.create({ data: { group_id: ZZ_GROUP, name: `${PREFIX}Electric`, position: 0 }, select: { id: true } });
  await prisma.catalogueItemTierPrice.create({ data: { catalogue_item_id: itemId.platinum, tier_id: evTier.id, price_ex_vat: null, availability: 'not_applicable' } });

  const site = await prisma.site.findFirst({ where: { group_id: ZZ_GROUP }, select: { id: true } });
  const cust = await prisma.customer.create({ data: { group_id: ZZ_GROUP, name: `${PREFIX}customer` }, select: { id: true } });
  const veh = await prisma.vehicle.create({ data: { group_id: ZZ_GROUP, registration: CAR, registration_normalized: CAR }, select: { id: true } });
  // stage_details_done because the Quote TAB is gated on Details being complete.
  const card = await prisma.jobCard.create({ data: {
    group_id: ZZ_GROUP, site_id: site.id, vehicle_id: veh.id, customer_id: cust.id,
    status: 'quoted', stage_details_done: true }, select: { id: true } });
  await prisma.jobCardItem.create({ data: {
    job_card_id: card.id, item_type: 'fixed', description: 'Bronze oil service', qty: 1,
    unit_price: 99, vat_rate: 20, vat_amount: 19.8, position: 0, catalogue_item_id: itemId.bronze } });

  browser = await chromium.launch({ channel: 'chrome' });
  const page = await (await browser.newContext()).newPage();
  await page.goto(`${gateOrigin()}/admin/login`, { waitUntil: 'domcontentloaded' });
  await page.fill('input[type="email"]', 'owner@zzgategarage.test');
  await page.fill('input[type="password"]', 'GateGarage!2026');
  await Promise.all([page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 60000 }), page.click('button[type="submit"]')]);
  await page.goto(`${gateOrigin()}/admin/jobcards/${card.id}?tab=quote`, { waitUntil: 'domcontentloaded' });
  const iconThere = await page.waitForSelector('[data-testid="offer-alternatives"]', { timeout: 60000 }).then(() => true).catch(() => false);
  check('the builder reaches the screen with the quoted line and its icons', iconThere,
    iconThere ? 'rendered' : ((await page.textContent('body')) ?? '').replace(/\s+/g, ' ').trim().slice(0, 160));

  /** Wait for the ROW to land, never for a spinner — the claim is about what was stored. */
  const until = async (fn, ms = 25000) => {
    const end = Date.now() + ms;
    for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) return null; await new Promise((r) => setTimeout(r, 250)); }
  };

  await page.click('[data-testid="offer-alternatives"]');
  const landed = await until(async () =>
    (await prisma.quoteOptionDraft.count({ where: { job_card_id: card.id } })) === 4 ? true : null);
  check('dropping the icon offers the WHOLE ladder, through the autosave', !!landed,
    landed ? '4 options' : `${await prisma.quoteOptionDraft.count({ where: { job_card_id: card.id } })} option(s) — expected 4`);

  const group = await prisma.quoteOptionGroupDraft.findFirst({ where: { job_card_id: card.id }, select: { title: true, shape: true } });
  check('  …as ONE pick_one group, named for the set', group?.shape === 'pick_one' && group?.title === `${PREFIX}Oil Services`,
    `${group?.shape} “${group?.title}”`);

  const lines = await prisma.jobCardItem.findMany({ where: { job_card_id: card.id }, orderBy: { position: 'asc' },
    select: { description: true, unit_price: true, option_draft_id: true, catalogue_item_id: true } });
  check('  …every rung arrives PRICED, as a line inside its own option',
    JSON.stringify(lines.map((l) => [l.description, Number(l.unit_price)]))
      === JSON.stringify([['Bronze oil service', 99], ['Silver oil service', 139], ['Gold oil service', 189], ['Platinum oil service', 249]]),
    lines.map((l) => `${l.description}=${l.unit_price}`).join(' | '));
  check('  …including the CHEAPER rungs, not only the dearer ones',
    lines.some((l) => l.catalogue_item_id === itemId.bronze) && lines.length === 4,
    'a customer moving down is still a sale — the dropped rung stays and the others join it');
  check('  …each in a DIFFERENT option, so choosing one excludes the rest',
    new Set(lines.map((l) => l.option_draft_id)).size === 4 && lines.every((l) => l.option_draft_id),
    `${new Set(lines.map((l) => l.option_draft_id)).size} distinct option(s)`);

  // THE WITHDRAWN RUNG. Same card, now on the electric tier: Platinum must not be offered at all.
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-testid="offer-alternatives"], [data-testid="group-editor"]', { timeout: 30000 }).catch(() => {});
  const evCard = await prisma.jobCard.create({ data: {
    group_id: ZZ_GROUP, site_id: site.id, vehicle_id: veh.id, customer_id: cust.id,
    status: 'quoted', stage_details_done: true }, select: { id: true } });
  await prisma.jobCardItem.create({ data: {
    job_card_id: evCard.id, item_type: 'fixed', description: 'Bronze oil service', qty: 1,
    unit_price: 99, vat_rate: 20, vat_amount: 19.8, position: 0, catalogue_item_id: itemId.bronze } });
  await page.goto(`${gateOrigin()}/admin/jobcards/${evCard.id}?tab=quote`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-testid="offer-alternatives"]', { timeout: 45000 });
  await page.selectOption('[data-testid="estimate-tier"]', evTier.id).catch(() => {});
  await page.click('[data-testid="offer-alternatives"]');
  const evLanded = await until(async () =>
    (await prisma.quoteOptionDraft.count({ where: { job_card_id: evCard.id } })) >= 3 ? true : null);
  const evLines = await prisma.jobCardItem.findMany({ where: { job_card_id: evCard.id }, select: { catalogue_item_id: true, description: true } });
  check('on a tier that withdraws a rung, the ladder offers FEWER rungs', !!evLanded && evLines.length === 3,
    `${evLines.length} line(s): ${evLines.map((l) => l.description).join(', ')}`);
  check('  …and the withdrawn rung is the one that is missing',
    !evLines.some((l) => l.catalogue_item_id === itemId.platinum),
    'an electric car offered a Platinum oil service at a plausible price is the defect this feature exists to stop');

  // ── 6. THE SWEEPABLE SHAPE ───────────────────────────────────────────────────────────────────
  console.log('\n— and the membership follows its set —');
  const before = await prisma.catalogueSetMember.count({ where: { set_id: ladderA } });
  await prisma.catalogueSet.delete({ where: { id: ladderA } });
  check('deleting a set takes its memberships, never the catalogue item',
    before === 1 && (await prisma.catalogueSetMember.count({ where: { set_id: ladderA } })) === 0
      && (await prisma.catalogueItem.count({ where: { id: bronze } })) === 1,
    'a set is a grouping; removing it is not a statement about the product');
} catch (e) {
  console.log(`\n✗ THREW: ${String(e?.stack ?? e).slice(0, 700)}`);
  out.push('F');
} finally {
  await browser?.close().catch(() => {});
  const left = await sweep().catch(() => -1);
  check('teardown removed every fixture row (ZZ only)', left >= 0,
    left < 0 ? 'the sweep itself threw — check ZZ for ZZCS- by hand' : `${left} item(s) removed`);
  console.log(`\n${out.filter((x) => x === 'F').length} failures of ${out.length}`);
  await prisma?.$disconnect();
  process.exit(out.includes('F') ? 1 : 0);
}
