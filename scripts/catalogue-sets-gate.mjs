/**
 * File: scripts/catalogue-sets-gate.mjs
 * @gate-requires: db
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
const { gatePrisma, describeError, ZZ_GROUP, onTeardown } = await import('./_gate-preflight.mjs');
import './_ts.mjs';

const out = [];
const check = (n, ok, d = '') => { out.push(ok ? 'P' : 'F'); console.log(`${ok ? '✓' : '✗'} ${n}${d ? `  — ${d}` : ''}`); };
const R = '/Users/hugh/Developer/greasedesk-core';
const CAT = await import(`${R}/lib/catalogue.ts`);
const QO = await import(`${R}/lib/quote-options.ts`);
const PREFIX = 'ZZCS-';

let prisma;
const sweep = async () => {
  if (!prisma) return 0;
  await prisma.catalogueSetMember.deleteMany({ where: { group_id: ZZ_GROUP, set: { name: { startsWith: PREFIX } } } }).catch(() => {});
  await prisma.catalogueSet.deleteMany({ where: { group_id: ZZ_GROUP, name: { startsWith: PREFIX } } }).catch(() => {});
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
  const left = await sweep().catch(() => -1);
  check('teardown removed every fixture row (ZZ only)', left >= 0,
    left < 0 ? 'the sweep itself threw — check ZZ for ZZCS- by hand' : `${left} item(s) removed`);
  console.log(`\n${out.filter((x) => x === 'F').length} failures of ${out.length}`);
  await prisma?.$disconnect();
  process.exit(out.includes('F') ? 1 : 0);
}
