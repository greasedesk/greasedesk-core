/**
 * File: scripts/wip-derivation-gate.mjs
 * WIP is DERIVED from the lines. The tile and the list read one formula, and adding a line moves both.
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────────────────────────────
 * The tile used to read JobCard.labour_bill_numeric + parts_bill_numeric — a denormalisation with
 * EXACTLY ONE WRITER (pages/api/jobcard-quote, on save). A denormalised figure diverges the moment
 * anything creates the underlying rows by another route, and fixtures are the most common other
 * route. It had already happened: four ZZ cards each carrying a £980 line while their stored
 * numerics read 0/0 — £3,920 of open work missing from the tile, on a tenant, silently.
 *
 * That is the FOURTH instance of one shape in a day: Payment.site_id, NotificationLog.group_id, the
 * JobCard cost numerics, this. A value that must agree with something else, kept in a second place,
 * with nothing making them agree.
 *
 * ── THE ASSERTION THAT MATTERS ──────────────────────────────────────────────────────────────────
 * Not "the figure is right today" — the cache was right most days too, which is what made it
 * dangerous. It is: ADD A LINE BY A ROUTE THAT IS NOT THE QUOTE SAVE, and the figure moves anyway.
 * That is the case the cache got wrong and no amount of correct-looking output would have revealed.
 *
 * ── FIXTURES ────────────────────────────────────────────────────────────────────────────────────
 * ZZ only. One JobCardItem written directly (never through the quote endpoint — writing through it
 * would defeat the entire point) and removed in the finally. Nothing on the card itself is touched,
 * so there is no card state to restore.
 */
import './_gate-preflight.mjs';
const { describeError } = await import('./_gate-preflight.mjs');
import './_ts.mjs';
const { prisma } = await import('../lib/db.ts');
const { wipCardsWhere, wipCardValuePennies, wipLineValuesPennies, WIP_STATUSES } = await import('../lib/wip.ts');
const { readFileSync } = await import('node:fs');

const ZZ = 'c75ac44e-250a-4c90-98ba-a8326e98dad5';
const MARK = 'wipgate fixture line';
const out = [];
const check = (n, ok, d = '') => { out.push(ok ? 'P' : 'F'); console.log(`${ok ? '✓' : '✗'} ${n}${d ? `  — ${d}` : ''}`); };
const P = (p) => `£${(p / 100).toFixed(2)}`;

let itemId = null;
try {
  const sites = (await prisma.site.findMany({ where: { group_id: ZZ }, select: { id: true } })).map((s) => s.id);
  const cards = await prisma.jobCard.findMany({ where: wipCardsWhere(sites), select: { id: true, is_comeback: true } });
  if (!cards.length) throw new Error('no ZZ WIP cards');
  const ids = cards.map((c) => c.id);
  const total = async () => {
    const lv = await wipLineValuesPennies(prisma, ids);
    return cards.reduce((a, c) => a + wipCardValuePennies(c, lv), 0);
  };

  // ── 1. IT READS THE LINES, NOT A COLUMN ────────────────────────────────────────────────────
  console.log('\n— the source —');
  const src = readFileSync('lib/wip.ts', 'utf8');
  // CODE ONLY. The first run of this check failed on the file's own COMMENT — which explains at
  // length why it no longer reads those columns. A scan that cannot tell an explanation from an
  // instruction is measuring prose. Same fix as the 'unresolved' scan in notify-scope-gate.
  const codeOf = (t) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  check('the chokepoint no longer reads a persisted bill column', !/labour_bill_numeric|parts_bill_numeric/.test(codeOf(src)),
    'the cache is not consulted in CODE, so it cannot be believed');
  check('the check is discriminating — the comment DOES still name them', /labour_bill_numeric/.test(src),
    'the explanation survives; only the read is gone');
  check('and it sums JobCardItem instead', /FROM "JobCardItem"/.test(src));
  check('rounded PER LINE, as computeQuoteTotals does', /ROUND\(qty \* unit_price \* 100\)/.test(src),
    'summing pounds and rounding once would disagree with the quote by a penny');
  for (const [f, label] of [['lib/dashboard-tiles.ts', 'the tile'], ['pages/admin/jobcards/index.tsx', 'the list']]) {
    check(`${label} calls the shared derivation`, /wipLineValuesPennies\(/.test(readFileSync(f, 'utf8')),
      'one formula, so the tile total and the list total cannot drift');
  }

  // ── 2. A LINE ADDED BY ANOTHER ROUTE MOVES THE FIGURE ──────────────────────────────────────
  // THE point. The fixture is written straight to JobCardItem — NOT through the quote endpoint,
  // because the quote endpoint is the one writer the cache did know about.
  console.log('\n— a line arriving by a route that is not the quote save —');
  const target = cards.find((c) => !c.is_comeback);
  if (!target) throw new Error('no non-comeback ZZ WIP card');
  const before = await total();
  itemId = (await prisma.jobCardItem.create({
    data: { job_card_id: target.id, item_type: 'part', description: MARK, qty: 3, unit_price: 12.34, vat_rate: 20 },
    select: { id: true },
  })).id;
  const after = await total();
  // 3 × £12.34 = £37.02, rounded per line.
  check('the WIP total rises by exactly the line', after - before === 3702, `${P(before)} → ${P(after)}`);

  // This used to contrast the move against the STALE CACHED COLUMN, which was the sharpest
  // available discriminator while the column existed. It does not exist any more (dropped in
  // 20260817200000), so the statement is now stronger and simpler: THERE IS NO CACHE TO DISAGREE.
  // Same evolution as revenue-period-gate's null-site fixture — the rule outlives the fixture.
  const cols = await prisma.$queryRawUnsafe(
    `SELECT column_name FROM information_schema.columns
      WHERE table_name = 'JobCard' AND column_name IN ('labour_bill_numeric','parts_bill_numeric')`);
  check('no persisted bill column exists on JobCard at all', cols.length === 0,
    cols.length ? `still present: ${cols.map((c) => c.column_name).join(', ')}` : 'the lines are the only source there is');
  // Discriminating: information_schema is genuinely being consulted, not returning empty for free.
  const sanity = await prisma.$queryRawUnsafe(
    `SELECT column_name FROM information_schema.columns
      WHERE table_name = 'JobCard' AND column_name = 'is_comeback'`);
  check('the check is discriminating — the query does find columns that DO exist', sanity.length === 1,
    'otherwise "no such column" would pass against a typo in the table name');

  // ── 3. THE COMEBACK RULE SURVIVED THE CHANGE ───────────────────────────────────────────────
  console.log('\n— the rules that were already there —');
  const lv = await wipLineValuesPennies(prisma, ids);
  const comeback = cards.find((c) => c.is_comeback);
  if (comeback) {
    check('a comeback still values at £0 however many lines it has',
      wipCardValuePennies(comeback, lv) === 0 && (lv.get(comeback.id) ?? 0) > 0,
      `card has ${P(lv.get(comeback.id) ?? 0)} of lines and contributes ${P(0)} — zero-revenue policy`);
  } else {
    check('a synthetic comeback values at £0', wipCardValuePennies({ id: 'x', is_comeback: true }, new Map([['x', 5000]])) === 0,
      'no real ZZ comeback in WIP right now, so proven against the pure function');
  }
  check('a card with no lines is £0, not unknown', wipCardValuePennies({ id: 'none', is_comeback: false }, new Map()) === 0,
    'absent from the map means it has no lines — genuinely zero');
  check('an empty card list costs no query', (await wipLineValuesPennies({ $queryRawUnsafe: async () => { throw new Error('queried'); } }, [])).size === 0);

  // ── 4. THE £3,920 THAT WAS MISSING ─────────────────────────────────────────────────────────
  // The four fixture cards are still there. Under the old basis they contributed nothing.
  console.log('\n— the gap that started this —');
  const zzTotal = await total();
  // An INDEPENDENT sum — plain SQL, not the library under test — must equal what the library
  // produces. The first version of this check hardcoded "4 × £980 = £3,920" from an earlier
  // reading; there are in fact 5 such lines totalling £4,320, so the assertion was describing a
  // fixture I had mis-remembered rather than the behaviour. Derive the target from the data.
  const indep = await prisma.$queryRawUnsafe(`
    SELECT COALESCE(SUM(ROUND(i.qty * i.unit_price * 100)), 0)::bigint AS pennies
      FROM "JobCard" c JOIN "JobCardItem" i ON i.job_card_id = c.id
     WHERE c.site_id = ANY($1::text[]) AND c.status IN ('accepted','in_progress')
       AND c.is_comeback = false
       AND NOT EXISTS (SELECT 1 FROM "Invoice" v WHERE v.job_card_id = c.id)`, sites);
  const independent = Number(indep[0].pennies);
  check('the library agrees with an independent sum of the same lines', zzTotal === independent,
    `lib ${P(zzTotal)} vs plain SQL ${P(independent)}`);
  // And the previously-invisible work is genuinely inside it, whatever its exact size.
  const clutch = await prisma.jobCardItem.aggregate({
    where: { description: 'Clutch replacement', job_card: { is: { site_id: { in: sites }, status: { in: WIP_STATUSES }, invoice: { is: null } } } },
    _sum: { unit_price: true }, _count: true,
  });
  const clutchP = Math.round(Number(clutch._sum.unit_price ?? 0) * 100);
  check('the work the cache valued at nothing is inside that total', clutchP > 0 && zzTotal >= clutchP,
    `${clutch._count} lines worth ${P(clutchP)}, inside ${P(zzTotal)} — the cache read these cards as £0`);
} catch (e) {
  check('run completed', false, describeError(e).slice(0, 300));
} finally {
  if (itemId) {
    await prisma.jobCardItem.delete({ where: { id: itemId } }).catch(() => {});
    check('teardown removed the fixture line', (await prisma.jobCardItem.count({ where: { id: itemId } })) === 0);
  }
  check('no fixture line survives', (await prisma.jobCardItem.count({ where: { description: MARK } })) === 0);
  console.log(`\n${out.filter((c) => c === 'F').length} failures of ${out.length}`);
  await prisma.$disconnect();
  process.exit(out.includes('F') ? 1 : 0);
}
