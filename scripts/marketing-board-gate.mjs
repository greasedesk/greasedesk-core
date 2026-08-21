/**
 * File: scripts/marketing-board-gate.mjs
 * THE PIPELINE — three stacks, computed, and what moves a car between them.
 *
 * The board it replaces was a two-tab list with "£1,214 of work due" at the top: four cars times
 * the tenant's average job, a figure describing none of them, rendered to a STANDARD mechanic with
 * no permission check at all. What is asserted here is the ordering, the movement, and that no
 * money reaches the shape.
 *
 * Fixtures on ZZ Gate Garage only. Never TMBS.
 */
import './_gate-preflight.mjs';
const { explainIfClientStale } = await import('./_gate-preflight.mjs');
import './_ts.mjs';
const { PrismaClient } = await import('@prisma/client');
const { readFileSync } = await import('node:fs');
const P = await import('../lib/marketing-pipeline.ts');
const B = await import('../lib/marketing-board.ts');
const prisma = new PrismaClient();

const ZZ = 'c75ac44e-250a-4c90-98ba-a8326e98dad5';
const CUST = 'Board Pipeline Fixture';
const out = [];
const check = (n, ok, d = '') => { out.push(ok ? 'P' : 'F'); console.log(`${ok ? '✓' : '✗'} ${n}${d ? `  — ${d}` : ''}`); };
const NOW = new Date('2026-08-21T10:00:00Z');
const base = { motBand: null, motDays: null, battery: null, lowestTreadTenths: null, findings: [], contact: null };

let fix = null;

try {
  const stale = await prisma.customer.count({ where: { group_id: ZZ, name: CUST } });
  if (stale) throw new Error(`REFUSING: ${stale} fixture(s) from a previous run still present`);

  // ── 1. WHAT MAKES A LEAD HOT ─────────────────────────────────────────────────────────────────
  console.log('\n— money available this week —');
  check('an expired MOT is hot', P.leadStack({ ...base, motBand: 'expired', motDays: -62 }, NOW).stack === 'hot');
  check('  …and says how long it has been off the road',
    /62 days ago/.test(P.leadStack({ ...base, motBand: 'expired', motDays: -62 }, NOW).reasons[0].text));
  check('  …and "expires today" is not "0 days ago"',
    /expires today/.test(P.leadStack({ ...base, motBand: 'expired', motDays: -0.2 }, NOW).reasons[0].text),
    'a rounding produced a sentence nobody says');
  check('a failed battery is hot', P.leadStack({ ...base, battery: 'replace' }, NOW).stack === 'hot');
  check('  …and a dead cell', P.leadStack({ ...base, battery: 'dead_cell' }, NOW).stack === 'hot');
  check('an illegal tyre is hot', P.leadStack({ ...base, lowestTreadTenths: 15 }, NOW).stack === 'hot');
  check('  …and 1.6mm exactly is NOT, because that is legal',
    P.leadStack({ ...base, lowestTreadTenths: 16 }, NOW).stack !== 'hot', 'the limit is a floor, not a threshold to cross');
  check('a job the customer agreed to and nobody booked is hot',
    P.leadStack({ ...base, findings: [{ description: 'Rear pads', response: 'agreed_later', dueWithinWindow: false }] }, NOW).stack === 'hot',
    'the purest lead there is: they already said yes');

  // ── 2. THE REFUSAL THAT MUST NOT BE SOLD ─────────────────────────────────────────────────────
  console.log('\n— a retest is not a sale —');
  const retest = P.leadStack({ ...base, battery: 'retest' }, NOW);
  check('an inconclusive battery is WARM, not hot', retest.stack === 'warm',
    'low charge and low health together: the code refuses to guess, and so must the board');
  check('  …and never says the customer needs a battery',
    !/need|failed|replace/i.test(retest.reasons[0].text), retest.reasons[0].text);
  check('  …it says get it back in and test it properly', /test it properly/.test(retest.reasons[0].text));
  const charging = P.leadStack({ ...base, battery: 'charging_fault' }, NOW);
  check('a charging fault is warm and blames the charging, not the battery',
    charging.stack === 'warm' && /charging did not/.test(charging.reasons[0].text), charging.reasons[0].text);
  check('a battery worth watching is not a lead at all',
    P.leadStack({ ...base, battery: 'monitor' }, NOW).reasons.length === 0,
    'monitor is a note on a document, not a phone call');

  // ── 3. THE MOVEMENT RULE ─────────────────────────────────────────────────────────────────────
  console.log('\n— what stops Hot becoming a graveyard —');
  const hotDeclined = P.leadStack({ ...base, motBand: 'expired', motDays: -62,
    contact: { state: 'declined', snoozeUntil: null, spent: false } }, NOW);
  check('a hot lead contacted and declined drops to Later', hotDeclined.stack === 'later');
  check('  …keeping the reason it was hot, so nobody loses the thread',
    hotDeclined.reasons.some((r) => r.kind === 'mot_expired'));
  const spent = P.leadStack({ ...base, motBand: 'expired', motDays: -62,
    contact: { state: 'declined', snoozeUntil: null, spent: true } }, NOW);
  check('  …and comes back up when its clock comes round', spent.stack === 'hot',
    'isUnactioned spends the record at read time — nothing scheduled, nothing to sweep');
  const snoozed = P.leadStack({ ...base, motBand: 'due', motDays: 20,
    contact: { state: 'snoozed', snoozeUntil: new Date('2026-09-30'), spent: false } }, NOW);
  check('a live snooze holds a car down', snoozed.stack === 'later' && /Snoozed until 30 September/.test(snoozed.reasons[0].text));
  check('being contacted can only push a car DOWN, never up',
    P.leadStack({ ...base, findings: [{ description: 'x', response: 'declined', dueWithinWindow: false }],
      contact: { state: 'contacted', snoozeUntil: null, spent: false } }, NOW).stack === 'later',
    'a car cannot be promoted by having been rung');

  // TIME PROMOTES, and nothing has to notice.
  console.log('\n— time promotes, with nothing scheduled —');
  const warmAt31 = P.leadStack({ ...base, motBand: 'due', motDays: 31 }, NOW);
  const hotWhenExpired = P.leadStack({ ...base, motBand: 'expired', motDays: -1 }, NOW);
  check('the same car is warm at 31 days and hot once expired',
    warmAt31.stack === 'warm' && hotWhenExpired.stack === 'hot');
  const src = readFileSync('lib/marketing-board.ts', 'utf8') + readFileSync('lib/marketing-pipeline.ts', 'utf8');
  check('  …and no stack is ever stored', !/stack:\s*(?:'hot'|'warm'|'later')\s*,?\s*\n?\s*\}\s*\)/.test(src)
    && !/data:\s*\{[^}]*stack/.test(src),
    'a stored stack is wrong between writes and needs something to sweep it');

  // ── 4. NO MONEY IN THE SHAPE ─────────────────────────────────────────────────────────────────
  console.log('\n— a count is true; an average describes nobody —');
  const board = readFileSync('lib/marketing-board.ts', 'utf8');
  const page = readFileSync('pages/admin/marketing.tsx', 'utf8');
  check('the board shape carries no money field',
    !/pennies|revenue|averagePennies|currency/i.test(board.replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, '')),
    'not a gated field — no field. There is nothing to leak.');
  check('  …and the page renders no figure', !/money\(|formatMoney/.test(page.replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, '')),
    'it rendered £1,214 to a STANDARD mechanic with no check at all');
  check('  …and the reason is written where the tile used to be', /A COUNT, NOT A VALUE/.test(page));

  // ── 5. THE BOARD EXPLAINS ITS OWN EMPTINESS ──────────────────────────────────────────────────
  console.log('\n— an empty Hot stack is usually an unasked question —');
  // ONE SENTENCE, both cases. On the tabbed board the empty Hot tab already says "Nothing hot
  // right now", so a prompt that opened with the same words said it twice and buried the half
  // that matters. The pair on an empty tab IS the whole screen.
  check('the prompt says what changes the position, not what it is',
    /each yes puts a car in Hot/.test(P.unansweredPrompt(0, 15) ?? ''), P.unansweredPrompt(0, 15));
  check('  …and does not repeat what the empty tab already says',
    !/Nothing hot/.test(P.unansweredPrompt(0, 15) ?? ''), P.unansweredPrompt(0, 15));
  check('  …reading the same with hot leads present', P.unansweredPrompt(6, 12) === P.unansweredPrompt(0, 12));
  check('  …and one finding is singular', /1 finding is waiting/.test(P.unansweredPrompt(0, 1) ?? ''),
    P.unansweredPrompt(0, 1));
  check('  …and says nothing when there is nothing to say', P.unansweredPrompt(3, 0) === null,
    'a prompt about zero findings is noise');

  // ── 6. AGAINST REAL DATA, INCLUDING HOW LONG IT TAKES ────────────────────────────────────────
  console.log('\n— built on a throwaway car, and timed —');
  const cust = await prisma.customer.create({ data: { group_id: ZZ, name: CUST, phone: '07700 900112' }, select: { id: true } });
  const veh = await prisma.vehicle.create({
    data: { group_id: ZZ, registration: 'ZZ76BRD', registration_normalized: 'ZZ76BRD', make: 'Board', model: 'Fixture',
      mot_expiry: new Date('2026-06-01T00:00:00.000Z') }, select: { id: true } });
  await prisma.vehicleOwnership.create({ data: { vehicle_id: veh.id, customer_id: cust.id, is_current: true } });
  fix = { veh: veh.id, cust: cust.id };

  const t0 = Date.now();
  const built = await B.buildBoard(ZZ, NOW);
  const ms = Date.now() - t0;
  const row = built.hot.find((r) => r.registration === 'ZZ76BRD');
  check('an expired car lands in Hot', !!row, built.hot.map((r) => r.registration).join(', '));
  check('  …with the phone number, whatever the role', row?.phone === '07700 900112',
    'no opt-out covers a phone call and no role gate covers ringing');
  check('  …and no money anywhere on the row',
    !Object.keys(row ?? {}).some((k) => /pennies|price|value|revenue/i.test(k)), Object.keys(row ?? {}).join(' '));
  // ── NO QUERY INSIDE THE PER-CAR LOOP ────────────────────────────────────────────────────────
  // Asserted STRUCTURALLY, because a timing budget cannot catch this where the gate runs: ZZ has a
  // handful of cars, so the N+1 version builds in milliseconds here and only bites on a real
  // fleet. Reintroducing a per-vehicle findMany passed the clock check clean. The rule is "one
  // read per collection, not one per car", and that is a property of the source.
  const boardSrc = readFileSync('lib/marketing-board.ts', 'utf8');
  const loopStart = boardSrc.indexOf('for (const v of vehicles) {');
  const loopEnd = boardSrc.indexOf('  const pick = (s: Stack)');
  const loopBody = boardSrc.slice(loopStart, loopEnd);
  const queriesInLoop = [...loopBody.matchAll(/await\s+prisma\.(\w+)\./g)].map((m) => m[1]);
  check('no database read happens inside the per-car loop', queriesInLoop.length === 0,
    queriesInLoop.length ? `prisma.${[...new Set(queriesInLoop)].join(', prisma.')} — one read per CAR is 600 round trips on a 222-car fleet` : 'every collection is fetched once and grouped in memory');
  // The clock stays as a coarse backstop, and its limits are stated rather than implied.
  check(`and the board builds quickly on the fixture tenant (${(ms / 1000).toFixed(1)}s)`, ms < 4000,
    'a weak check here by construction — ZZ is small; the structural assertion above is the real one');
} catch (e) {
  check('gate run completed', false, String(e?.message ?? e).slice(0, 300));
  await explainIfClientStale(process.env.GATE_BASE ?? 'http://localhost:3000');
} finally {
  if (fix) {
    const step = async (n, fn) => { try { await fn(); } catch (e) { console.log(`  teardown ${n}: ${String(e?.message ?? e).slice(0, 90)}`); } };
    await step('edges', () => prisma.vehicleOwnership.deleteMany({ where: { vehicle_id: fix.veh } }));
    await step('vehicle', () => prisma.vehicle.deleteMany({ where: { group_id: ZZ, registration: 'ZZ76BRD' } }));
    await step('customer', () => prisma.customer.deleteMany({ where: { group_id: ZZ, name: CUST } }));
    check('teardown removed every fixture row (ZZ only)',
      (await prisma.vehicle.count({ where: { group_id: ZZ, registration: 'ZZ76BRD' } })) === 0
      && (await prisma.customer.count({ where: { group_id: ZZ, name: CUST } })) === 0);
  }
}

console.log(`\n${out.filter((x) => x === 'F').length} failures of ${out.length}`);
await prisma.$disconnect();
process.exit(out.includes('F') ? 1 : 0);
