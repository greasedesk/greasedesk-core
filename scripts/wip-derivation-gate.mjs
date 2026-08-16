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

  // Discriminating: the OLD basis would not have moved at all — the stored column is untouched by
  // this write. Proven directly rather than asserted, using the column that still exists.
  const stored = await prisma.jobCard.findUnique({
    where: { id: target.id }, select: { labour_bill_numeric: true, parts_bill_numeric: true },
  });
  const oldBasis = Math.round((Number(stored.labour_bill_numeric ?? 0) + Number(stored.parts_bill_numeric ?? 0)) * 100);
  const derived = (await wipLineValuesPennies(prisma, [target.id])).get(target.id) ?? 0;
  check('the check is discriminating — the CACHED column did NOT move', derived - oldBasis === 3702,
    `cache ${P(oldBasis)} vs lines ${P(derived)} — this gap is the defect, reproduced on demand`);

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
  const zzCached = (await prisma.jobCard.findMany({ where: wipCardsWhere(sites), select: { is_comeback: true, labour_bill_numeric: true, parts_bill_numeric: true } }))
    .filter((c) => !c.is_comeback)
    .reduce((a, c) => a + Math.round((Number(c.labour_bill_numeric ?? 0) + Number(c.parts_bill_numeric ?? 0)) * 100), 0);
  check('ZZ WIP now includes the work the cache could not see', zzTotal > zzCached,
    `derived ${P(zzTotal)} vs cached ${P(zzCached)} — a difference of ${P(zzTotal - zzCached)}`);
} catch (e) {
  check('run completed', false, String(e?.message ?? e).slice(0, 300));
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
