/**
 * File: scripts/mot-urgency-gate.mjs
 * @gate-requires: db, server
 *
 * THE MOT ON THE LEADS LIST: four weeks moves a car to HOT, one week turns its DATE red, and the
 * date is a COLUMN rather than a phrase inside a sentence.
 *
 * ── THREE WINDOWS, AND THEY MUST STAY THREE ─────────────────────────────────────────────────────
 * MOT_SOON_DAYS (28, the banner and now the move to Hot), MOT_URGENT_DAYS (7, the red date) and
 * WINDOW_DAYS (30, whether the car is on the board at all) answer three different questions. The
 * owner's instruction was explicitly not to unify them, so this gate asserts they DISAGREE rather
 * than asserting their values: a later decision may legitimately move any of the three, and what
 * must not happen is one number quietly answering all three.
 *
 * ── THE FIXTURE OFFSETS ARE DERIVED FROM THE CONSTANTS ──────────────────────────────────────────
 * A car at "29 days" is written as MOT_SOON_DAYS + 1, so the boundary clauses keep testing the
 * boundary if the window moves. That only works while MOT_SOON_DAYS + 1 is still inside
 * WINDOW_DAYS — otherwise the car falls off the board entirely and the clause would pass by being
 * absent — so that premise is CHECKED here rather than stated in a comment.
 *
 * ── AND IT IS DRIVEN ON SCREEN ──────────────────────────────────────────────────────────────────
 * The column's whole purpose is that the dates line up and the near ones are red, which a source
 * scan cannot see. The browser clauses read the resolved colour and the laid-out boxes.
 *
 * Fixtures on ZZ Gate Garage only, prefix ZZMOT, swept before and after. Never TMBS.
 */
import './_gate-preflight.mjs';
const { gatePrisma, describeError, ZZ_GROUP, gateOrigin, serverReady } = await import('./_gate-preflight.mjs');
import './_ts.mjs';
const { chromium } = await import('/Users/hugh/Developer/greasedesk-core/node_modules/playwright-core/index.mjs');
const { readFileSync } = await import('node:fs');

const out = [];
const check = (n, ok, d = '') => { out.push(ok ? 'P' : 'F'); console.log(`${ok ? '✓' : '✗'} ${n}${d ? `  — ${d}` : ''}`); };
const R = '/Users/hugh/Developer/greasedesk-core';
const MB = await import(`${R}/lib/mot-banner.ts`);
const ML = await import(`${R}/lib/marketing-lists.ts`);
const P = await import(`${R}/lib/marketing-pipeline.ts`);
const BOARD = await import(`${R}/lib/marketing-board.ts`);
const SOON = MB.MOT_SOON_DAYS;
const URGENT = MB.MOT_URGENT_DAYS;
const WINDOW = ML.WINDOW_DAYS;
const DAY = 86_400_000;
const PREFIX = 'ZZMOT';
const NOW = new Date('2026-10-01T09:00:00Z');
/** The rendered fixtures are dated from the REAL clock — the page judges against its own `now`. */
const REAL = new Date();
const realIn = (days) => new Date(REAL.getTime() + days * DAY);
const base = { motBand: null, motDays: null, battery: null, lowestTreadTenths: null, findings: [], contact: null };

let prisma = null;
let browser = null;
let fix = null;
try {
  prisma = await gatePrisma();

  // ── THREE WINDOWS ─────────────────────────────────────────────────────────────────────────────
  console.log('— three windows, three questions —');
  const homes = (name) => ['lib/mot-banner.ts', 'lib/marketing-lists.ts', 'lib/marketing-pipeline.ts', 'lib/marketing-board.ts', 'pages/admin/marketing.tsx']
    .filter((f) => new RegExp(`${name}\\s*=\\s*\\d`).test(readFileSync(`${R}/${f}`, 'utf8')));
  check('MOT_SOON_DAYS is declared once, in lib/mot-banner', JSON.stringify(homes('MOT_SOON_DAYS')) === '["lib/mot-banner.ts"]', homes('MOT_SOON_DAYS').join(', '));
  check('MOT_URGENT_DAYS too — beside it, where a reader compares them', JSON.stringify(homes('MOT_URGENT_DAYS')) === '["lib/mot-banner.ts"]', homes('MOT_URGENT_DAYS').join(', '));
  check('WINDOW_DAYS stays in lib/marketing-lists', JSON.stringify(homes('WINDOW_DAYS')) === '["lib/marketing-lists.ts"]', homes('WINDOW_DAYS').join(', '));
  check('all three DISAGREE — not one number answering three questions',
    new Set([SOON, URGENT, WINDOW]).size === 3, `soon ${SOON}, urgent ${URGENT}, window ${WINDOW}`);
  check('the urgent window is the tightest of the three', URGENT < SOON && SOON <= WINDOW, `${URGENT} < ${SOON} <= ${WINDOW}`);
  const pipe = readFileSync(`${R}/lib/marketing-pipeline.ts`, 'utf8');
  check('the pipeline reads the constant, not a number of its own',
    /days <= MOT_SOON_DAYS/.test(pipe) && !/days <= 28/.test(pipe));
  // COMMENTS STRIPPED: the component's own doc comment NAMES motDateEmphasis to say where the rule
  // lives, and a raw scan read that as the page holding the rule.
  const pageSrc = readFileSync(`${R}/pages/admin/marketing.tsx`, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  check('the leads page holds NO window at all — it renders the server\'s answer',
    !/MOT_SOON_DAYS|MOT_URGENT_DAYS|motDateEmphasis/.test(pageSrc) && /row\.motEmphasis/.test(pageSrc),
    'a threshold on the board would be a fourth window nobody declared');

  // ── THE MOVE TO HOT ───────────────────────────────────────────────────────────────────────────
  console.log('\n— four weeks out is HOT —');
  const stackAt = (days) => P.leadStack({ ...base, motBand: 'due', motDays: days }, NOW);
  check(`exactly ${SOON} days out is HOT`, stackAt(SOON).stack === 'hot', JSON.stringify(stackAt(SOON).reasons[0]));
  check('  …one day further out is WARM — the board\'s window keeps the rest', stackAt(SOON + 1).stack === 'warm', JSON.stringify(stackAt(SOON + 1).reasons[0]));
  check('  …and one day inside is still HOT', stackAt(SOON - 1).stack === 'hot');
  check('a day out is hot', stackAt(1).stack === 'hot');
  check('EXPIRED is hot, as it was', P.leadStack({ ...base, motBand: 'expired', motDays: -10 }, NOW).stack === 'hot');
  check('the KIND is mot_due in BOTH stacks — the contact record still says what the call was about',
    stackAt(SOON).reasons[0].kind === 'mot_due' && stackAt(SOON + 1).reasons[0].kind === 'mot_due',
    'one kind, two stacks — the same shape quote_open already has');
  check('the sentence is unchanged on both sides of the line',
    stackAt(SOON).reasons[0].text === `MOT due in ${SOON} days` && stackAt(SOON + 1).reasons[0].text === `MOT due in ${SOON + 1} days`,
    stackAt(SOON).reasons[0].text);
  check('a band with NO clock is not promoted on an absence — Warm, not Hot',
    P.leadStack({ ...base, motBand: 'due', motDays: null }, NOW).stack === 'warm',
    'we cannot claim a car is within four weeks when we hold no date');
  const snoozedHot = P.leadStack({ ...base, motBand: 'due', motDays: 2, contact: { state: 'snoozed', snoozeUntil: new Date(NOW.getTime() + 20 * DAY), contactStands: true } }, NOW);
  check('a snooze still outranks it — the garage\'s own answer pushes DOWN, promotion never up', snoozedHot.stack === 'later', snoozedHot.stack);
  check('urgency is unchanged: the nearest clock still decides',
    stackAt(3).urgency === 1 + 3 && stackAt(SOON).urgency === 1 + SOON, `${stackAt(3).urgency} / ${stackAt(SOON).urgency}`);

  // ── THE RED DATE ──────────────────────────────────────────────────────────────────────────────
  console.log('\n— one week turns the DATE red —');
  const emph = (days) => MB.motDateEmphasis(new Date(NOW.getTime() + days * DAY), NOW);
  check('yesterday → expired', emph(-1) === 'expired');
  check('today → urgent, not expired — it is legal until midnight', emph(0) === 'urgent');
  check(`exactly ${URGENT} days → urgent`, emph(URGENT) === 'urgent');
  check('  …one day further out → plain', emph(URGENT + 1) === 'plain');
  check('NO DATE → null, never "plain" — a missing MOT must not read as a passing one', MB.motDateEmphasis(null, NOW) === null);
  check('  …and an unparseable date is the same absence', MB.motDateEmphasis('not a date', NOW) === null);
  check('a date given as YYYY-MM-DD reads as that day, not the day before',
    MB.motDateEmphasis('2026-10-08', new Date('2026-10-01T23:30:00Z')) === 'urgent', 'the stored column is a date; the clock is an instant');
  // THE DATE-COLUMN TRAP, which cost this slice a wrong stack before the gate caught it:
  // mot_expiry is @db.Date, so it reads back as MIDNIGHT, and an instant subtraction in the
  // afternoon loses most of a day. Counted in CALENDAR days both surfaces agree.
  check('a midnight date 29 days out, read in the AFTERNOON, is 29 days — not 28',
    MB.motDaysUntil(new Date('2026-10-30T00:00:00Z'), new Date('2026-10-01T14:00:00Z')) === 29,
    'the instant subtraction this replaced gave 28.4, printed "28 days", and would have put the car in Hot');
  check('  …and the day it expires is 0, not -1', MB.motDaysUntil(new Date('2026-10-01T00:00:00Z'), new Date('2026-10-01T14:00:00Z')) === 0);
  check('  …and yesterday is -1', MB.motDaysUntil(new Date('2026-09-30T00:00:00Z'), new Date('2026-10-01T14:00:00Z')) === -1);

  // ── FIXTURES: THE BOARD AND THE COLUMN ───────────────────────────────────────────────────────
  console.log('\n— on the board, on ZZ —');
  check(`premise: ${SOON} + 1 days is still inside the board's ${WINDOW}-day window`, SOON + 1 <= WINDOW,
    'otherwise the WARM fixture falls off the board and its clause would pass by being absent');
  const sweep = () => prisma.vehicle.deleteMany({ where: { group_id: ZZ_GROUP, registration: { startsWith: PREFIX } } });
  await prisma.marketingContact.deleteMany({ where: { group_id: ZZ_GROUP, vehicle: { registration: { startsWith: PREFIX } } } }).catch(() => {});
  await sweep();
  const CARS = [
    ['1', -10, 'expired', 'hot'],
    ['2', URGENT - 4, 'urgent', 'hot'],
    ['3', SOON - 3, 'plain', 'hot'],
    ['4', SOON + 1, 'plain', 'warm'],
  ];
  const ids = {};
  for (const [n, days] of CARS) {
    const v = await prisma.vehicle.create({
      data: {
        group_id: ZZ_GROUP, registration: `${PREFIX}${n}`, registration_normalized: `${PREFIX}${n}`,
        make: 'Gate', model: 'Fixture', mot_expiry: realIn(days), mot_checked_at: REAL,
      },
      select: { id: true },
    });
    ids[n] = v.id;
  }
  fix = { ids: Object.values(ids) };
  const board = await BOARD.buildBoard(ZZ_GROUP);
  const whereIs = (reg) => ['hot', 'warm', 'later'].find((k) => board[k].some((r) => r.registration === reg)) ?? 'absent';
  const rowOf = (reg) => [...board.hot, ...board.warm, ...board.later].find((r) => r.registration === reg);
  for (const [n, days, wantEmph, wantStack] of CARS) {
    check(`${PREFIX}${n} (${days} days) sits in ${wantStack.toUpperCase()}`, whereIs(`${PREFIX}${n}`) === wantStack, whereIs(`${PREFIX}${n}`));
    check(`  …and its date is '${wantEmph}'`, rowOf(`${PREFIX}${n}`)?.motEmphasis === wantEmph, String(rowOf(`${PREFIX}${n}`)?.motEmphasis));
  }
  check('the row carries the MOT date itself, not the contact trigger',
    rowOf(`${PREFIX}2`)?.motExpiry === realIn(URGENT - 4).toISOString().slice(0, 10), rowOf(`${PREFIX}2`)?.motExpiry ?? 'null');

  const ready = await serverReady();
  check('the dev server serves pages before we drive it', ready.ok, `HTTP ${ready.status}`);
  const origin = gateOrigin();
  browser = await chromium.launch({ channel: 'chrome' });
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 1000 } });
  const pg = await ctx.newPage();
  await pg.goto(`${origin}/admin/login`, { waitUntil: 'domcontentloaded' });
  await pg.fill('input[type="email"]', 'owner@zzgategarage.test');
  await pg.fill('input[type="password"]', 'GateGarage!2026');
  await Promise.all([pg.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 60000 }), pg.click('button[type="submit"]')]);
  await pg.goto(`${origin}/admin/marketing`, { waitUntil: 'domcontentloaded' });
  await pg.waitForSelector(`[data-testid="lead-mot-${ids['1']}"]`, { timeout: 30000 }).catch(() => {});
  /**
   * THE BOARD IS TABBED, so a cell is only in the DOM on its own stack's tab. Read the Hot tab
   * (the three hot fixtures), then the Warm one — the first version looked for all four at once
   * and reported the warm car as MISSING, which reads as a render defect and was a tab.
   */
  const readCells = (want) => pg.evaluate((w) => {
    const danger = getComputedStyle(document.documentElement).getPropertyValue('--danger').trim();
    const toRgb = (hex) => { const h = hex.replace('#', ''); return `rgb(${parseInt(h.slice(0, 2), 16)}, ${parseInt(h.slice(2, 4), 16)}, ${parseInt(h.slice(4, 6), 16)})`; };
    const cells = {};
    for (const [k, id] of Object.entries(w)) {
      const el = document.querySelector(`[data-testid="lead-mot-${id}"]`);
      if (!el) { cells[k] = null; continue; }
      const date = el.lastElementChild;
      const r = el.getBoundingClientRect();
      cells[k] = {
        text: el.textContent, emphasis: el.getAttribute('data-emphasis'), title: el.getAttribute('title'),
        colour: date ? getComputedStyle(date).color : null,
        right: Math.round(r.right), width: Math.round(r.width), painted: r.width > 0 && r.height > 0 && !!el.offsetParent,
      };
    }
    return { cells, dangerRgb: danger.startsWith('#') ? toRgb(danger) : danger };
  }, want);
  const hotSeen = await readCells({ 1: ids['1'], 2: ids['2'], 3: ids['3'] });
  await pg.click('[data-testid="stack-tab-warm"]');
  await pg.waitForSelector(`[data-testid="lead-mot-${ids['4']}"]`, { timeout: 15000 }).catch(() => {});
  const warmSeen = await readCells({ 4: ids['4'] });
  const c = { ...hotSeen.cells, ...warmSeen.cells };
  const DANGER = hotSeen.dangerRgb;
  check('every fixture car shows an MOT cell, laid out and painted',
    CARS.every(([n]) => c[n]?.painted), CARS.map(([n]) => `${n}:${c[n] ? 'yes' : 'MISSING'}`).join(' '));
  check('the cell is LABELLED — a bare date in an unheaded column says nothing',
    CARS.every(([n]) => /^MOT /.test(c[n]?.text ?? '')), c['1']?.text ?? '');
  check('it prints the date in words a person reads, not an ISO column',
    /^MOT \d{1,2} \w{3,4} \d{4}$/.test(c['2']?.text ?? ''), c['2']?.text ?? '');
  check('the expired and the urgent dates are RED — the resolved token',
    c['1']?.colour === DANGER && c['2']?.colour === DANGER, `${c['1']?.colour} / ${c['2']?.colour} vs ${DANGER}`);
  check('  …and the two ordinary ones are NOT — exactly two of four are coloured',
    c['3']?.colour !== DANGER && c['4']?.colour !== DANGER, `${c['3']?.colour} / ${c['4']?.colour}`);
  check('the dates LINE UP down the stack: one right edge, one width — that is what makes it a column',
    new Set([c['1']?.right, c['2']?.right, c['3']?.right]).size === 1 && new Set([c['1']?.width, c['2']?.width, c['3']?.width]).size === 1,
    [1, 2, 3].map((n) => `${c[n]?.right}/${c[n]?.width}`).join(' '));
  check('and it is a COLUMN, not a phrase in the reason sentence',
    !/MOT due in/.test(c['2']?.text ?? ''), c['2']?.text ?? '');
  check('the emphasis the SERVER decided is what the cell carries',
    CARS.every(([n, , e]) => c[n]?.emphasis === e), CARS.map(([n]) => `${n}:${c[n]?.emphasis}`).join(' '));
} catch (e) {
  check('run completed', false, describeError(e).slice(0, 400));
} finally {
  if (browser) await browser.close().catch(() => {});
  if (prisma && fix) {
    await prisma.marketingContact.deleteMany({ where: { vehicle_id: { in: fix.ids } } }).catch(() => {});
    await prisma.vehicle.deleteMany({ where: { id: { in: fix.ids } } });
    const left = await prisma.vehicle.count({ where: { id: { in: fix.ids } } });
    check('teardown removed every fixture row (audit rows stay — append-only)', left === 0, `${left} left`);
  }
  if (prisma) await prisma.$disconnect();
}
console.log(`\n${out.filter((c2) => c2 === 'F').length} failures of ${out.length}`);
process.exit(out.includes('F') ? 1 : 0);
