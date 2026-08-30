/**
 * File: scripts/due-timing-gate.mjs
 * ONE ANSWER TO "WHEN", NOT TWO.
 *
 * printedDueItemsBlock appends dueLabel() to every description, which put this on a real customer's
 * invoice: "Battery — 9.00V resting, a cell has failed. Replace. due at the next service". Two
 * answers to one question, and the second one wrong about the car.
 *
 * The assertions are about the SHAPE of that failure — a description that carries its own timing
 * must not be given a second one — and about the half that suppression alone would have missed:
 * a failed cell whose ROW still said "next service" would sort behind a tyre due at 60,000 miles.
 *
 * It also proves freeze-at-issue on the one document that can prove it. Fixtures on ZZ only.
 */
import './_gate-preflight.mjs';
const { zzSite, describeError } = await import('./_gate-preflight.mjs');
import './_ts.mjs';
const { PrismaClient } = await import('@prisma/client');
const B = await import('../lib/battery.ts');
const O = await import('../lib/observations.ts');
const D = await import('../lib/due-items.ts');
const prisma = new PrismaClient();

const ZZ = 'c75ac44e-250a-4c90-98ba-a8326e98dad5';
const out = [];
const check = (n, ok, d = '') => { out.push(ok ? 'P' : 'F'); console.log(`${ok ? '✓' : '✗'} ${n}${d ? `  — ${d}` : ''}`); };
const R = (v, soc, soh, extra = {}) => ({ voltageMv: Math.round(v * 1000), socPct: soc, sohPct: soh, ...extra });
const SEPT = new Date('2026-09-15T00:00:00Z');

// ── 0. THE DOCUMENT THAT ALREADY WENT OUT ───────────────────────────────────────────────────────
// Captured BEFORE anything else runs. Freeze-at-issue is a claim about documents surviving changes
// to the code that produced them; this slice changes exactly that code, so this is the moment the
// claim is testable rather than merely stated.
const FROZEN = await prisma.invoice.findFirst({
  where: { invoice_number: '100003220' },
  select: { due_items_snapshot: true, invoice_number: true },
});

let fix = null;

try {
  // ── 1. THE PREDICATE ─────────────────────────────────────────────────────────────────────────
  console.log('\n— who decides whether a timing is appended —');
  check('a normal finding gets its label', D.showsDueLabel({ timingInDescription: false }));
  check('one that carries its own does not', !D.showsDueLabel({ timingInDescription: true }));
  check('an ABSENT flag behaves as a normal finding', D.showsDueLabel({}),
    'the column defaults false and every pre-existing row means "what" plus a basis');

  // ── 2. NOT DERIVED FROM THE STRING ───────────────────────────────────────────────────────────
  console.log('\n— authored, never inferred —');
  const read = (await import('node:fs')).readFileSync;
  const prose = (t) => t.replace(/^\s*\*\s?/gm, ' ').replace(/\s+/g, ' ');
  const di = read('lib/due-items.ts', 'utf8');
  check('the predicate reads the flag, not the description',
    /timingInDescription !== true/.test(di) && !/description\.(endsWith|match|includes)/.test(di),
    'deriving meaning from description text is the mistake observation_key exists to undo');
  check('  …and that reason is written down', /the mistake observation_key exists to undo/.test(prose(di)));

  // ── 3. NOT `urgent` ──────────────────────────────────────────────────────────────────────────
  console.log('\n— a nearby boolean that means something else —');
  const cases = [
    ['dead_cell', R(9.0, 7, 8)], ['replace', R(12.5, 88, 41)], ['monitor', R(12.5, 88, 62)],
    ['charging_fault', R(12.1, 32, 88)], ['retest', R(11.98, 0, 17)],
  ];
  const adv = Object.fromEntries(cases.map(([k, n]) => [k, B.batteryAdvisory(n, SEPT)]));
  check('every advisory states both flags', cases.every(([k]) => typeof adv[k].carriesOwnTiming === 'boolean' && typeof adv[k].urgent === 'boolean'));
  check('RETEST is not urgent but DOES carry its own timing',
    adv.retest.urgent === false && adv.retest.carriesOwnTiming === true,
    'the case that proves the two flags are different questions');
  check('DEAD CELL is urgent and does NOT carry its own timing',
    adv.dead_cell.urgent === true && adv.dead_cell.carriesOwnTiming === false,
    'it has a real date instead, so the label is welcome');
  check('  …so the two flags genuinely disagree, in both directions',
    cases.some(([k]) => adv[k].urgent && !adv[k].carriesOwnTiming)
    && cases.some(([k]) => !adv[k].urgent && adv[k].carriesOwnTiming),
    'reusing `urgent` would have been wrong on two of five states');

  // ── 4. NO DESCRIPTION THAT KEEPS ITS LABEL ENDS A SENTENCE ───────────────────────────────────
  console.log('\n— the ones that still get a label have to read as one line —');
  const labelled = cases.filter(([k]) => !adv[k].carriesOwnTiming);
  check('none of them ends in a full stop', labelled.every(([k]) => !/\.$/.test(adv[k].description)),
    labelled.map(([k]) => adv[k].description.slice(-28)).join(' | '));
  for (const [k] of labelled) {
    const line = `${adv[k].description} ${D.dueLabel({ dueBasis: 'next_service', dueDate: null, dueMileage: null })}`;
    check(`  ${k} composes into one sentence`, !/\.\s+[a-z]/.test(line), line);
  }

  // ── 5. THE BLOCK ─────────────────────────────────────────────────────────────────────────────
  console.log('\n— what prints —');
  const block = D.printedDueItemsBlock({
    motExpiry: null,
    items: [
      { description: 'Wiper blades smearing', dueBasis: 'next_service', dueDate: null, dueMileage: null, timingInDescription: false },
      { description: 'Battery — 41% health, replace before winter', dueBasis: 'next_service', dueDate: null, dueMileage: null, timingInDescription: true },
    ],
  });
  check('a normal finding still says when', /\(1\) Wiper blades smearing due at the next service/.test(block));
  check('a self-timed one is left alone', /\(2\) Battery — 41% health, replace before winter$/.test(block), JSON.stringify(block));
  check('  …and is NOT told to wait for the next service', !/replace before winter due/.test(block));

  // ── 6. THE ORDERING HALF ─────────────────────────────────────────────────────────────────────
  console.log('\n— fixing the sentence and leaving the row wrong would be the symptom —');
  const site = await zzSite(prisma);
  const veh = await prisma.vehicle.create({ data: { group_id: ZZ, registration: 'ZZ76TIM2', make: 'Timing', model: 'Fixture' }, select: { id: true } });
  const card = await prisma.jobCard.create({ data: { group_id: ZZ, site_id: site.id, vehicle_id: veh.id, status: 'draft' }, select: { id: true } });
  fix = { veh: veh.id, card: card.id };

  await prisma.$transaction((tx) => B.recordBatteryReading(tx, {
    groupId: ZZ, vehicleId: veh.id, jobCardId: card.id, measuredBy: null, reading: R(9.0, 7, 8), measuredAt: SEPT,
  }));
  const dead = await prisma.vehicleDueItem.findFirst({
    where: { vehicle_id: veh.id }, select: { description: true, due_basis: true, due_date: true, timing_in_description: true },
  });
  check('a failed cell is due on the day it was measured, not at the next service',
    dead?.due_basis === 'date' && dead?.due_date?.toISOString().slice(0, 10) === '2026-09-15',
    `${dead?.due_basis} / ${dead?.due_date?.toISOString().slice(0, 10)}`);
  // NULL-SAFE THROUGHOUT. A probe that removes the real date makes due_date null, and reading
  // .toISOString() off it aborted the run — so the gate reported the first failure and skipped the
  // rest. A gate must fail loudly AND completely.
  const deadIso = dead?.due_date ? dead.due_date.toISOString().slice(0, 10) : null;
  check('  …so it sorts as the urgent thing it is',
    deadIso != null && D.effectiveDueDate({ dueBasis: dead.due_basis, dueDate: deadIso, dueMileage: null }) != null,
    'a next_service item has no date to sort on and would sit behind a tyre due at 60k');
  check('  …and it keeps its label, because the date is true', dead?.timing_in_description === false);
  const deadLine = D.printedDueItemsBlock({ motExpiry: null, items: [{
    description: dead?.description ?? '', dueBasis: dead?.due_basis ?? 'next_service',
    dueDate: deadIso, dueMileage: null, timingInDescription: dead?.timing_in_description ?? false,
  }] }) ?? '';
  check('  …printing as a restatement rather than a contradiction', /a cell has failed\. Replace due by /.test(deadLine), deadLine);
  // BRITISH, like the MOT line in the same block. The basis label printed a raw ISO date, which
  // nothing noticed while no finding used a `date` basis — and a failed cell now does.
  check('  …and the date is written the way a customer reads it',
    /due by 15 September 2026$/.test(deadLine) && !/2026-09-15/.test(deadLine), deadLine);
  check('  …matching the MOT line in the same block', (() => {
    const both = D.printedDueItemsBlock({ motExpiry: new Date('2026-08-21T00:00:00Z'), items: [{
      description: 'X', dueBasis: 'date', dueDate: '2026-09-15', dueMileage: null, timingInDescription: false }] });
    return /MOT Expiry 21 August 2026/.test(both) && /due by 15 September 2026/.test(both);
  })(), 'one block must not carry two date formats');

  // A REPLACE case: no honest date exists, so it is suppressed instead.
  await prisma.$transaction((tx) => B.recordBatteryReading(tx, {
    groupId: ZZ, vehicleId: veh.id, jobCardId: card.id, measuredBy: null, reading: R(12.5, 88, 41), measuredAt: SEPT,
  }));
  const repl = await prisma.vehicleDueItem.findFirst({ where: { vehicle_id: veh.id }, select: { description: true, due_basis: true, timing_in_description: true } });
  check('a replace-before-winter finding suppresses the label instead', repl?.timing_in_description === true,
    'no defensible date exists, and a November deadline would be a policy dressed as a measurement');
  check('  …and the residual untruth is RECORDED, not papered over',
    /make .?due_basis.? NULLABLE/i.test(prose(di)) && /deserves its own report/.test(prose(di)),
    'the row still says next_service; the next person should find the reasoning');

  // ── 7. OBSERVATIONS DECIDE TOO ───────────────────────────────────────────────────────────────
  console.log('\n— every catalogue entry had to answer —');
  check('the field is required on the type, so a new entry must decide',
    /carriesOwnTiming: boolean;/.test(read('lib/observations.ts', 'utf8')));
  check('all twenty-five say false today', O.OBSERVATIONS.every((o) => o.carriesOwnTiming === false),
    'plain noun phrases — "Wiper blades smearing" — where the basis is what says when');
} catch (e) {
  check('gate run completed', false, describeError(e).slice(0, 300));
} finally {
  if (fix) {
    const step = async (n, f) => { try { await f(); } catch (e) { console.log(`  teardown ${n}: ${describeError(e).slice(0, 90)}`); } };
    await step('battery', () => prisma.batteryReading.deleteMany({ where: { vehicle_id: fix.veh } }));
    await step('due items', () => prisma.vehicleDueItem.deleteMany({ where: { vehicle_id: fix.veh } }));
    await step('card', () => prisma.jobCard.deleteMany({ where: { id: fix.card } }));
    await step('vehicle', () => prisma.vehicle.delete({ where: { id: fix.veh } }));
    check('teardown removed every fixture row (ZZ only)',
      (await prisma.vehicle.count({ where: { group_id: ZZ, id: fix.veh } })) === 0
      && (await prisma.vehicleDueItem.count({ where: { group_id: ZZ, vehicle_id: fix.veh } })) === 0);
  }
}

// ── 8. FREEZE-AT-ISSUE, TESTED ──────────────────────────────────────────────────────────────────
// The claim is that a document reprints identically however the producing code changes. This slice
// changed that code, and invoice 100003220 is the only document in the database carrying a block —
// including the contradictory line this slice exists to stop, and "against 9 CCA EN" from before
// the floor. It must still say both, byte for byte. Fixing a customer's document to match our
// current wording would be the worse error.
console.log('\n— the one document that can prove freeze-at-issue —');
const after = await prisma.invoice.findFirst({
  where: { invoice_number: '100003220' }, select: { due_items_snapshot: true },
});
check('the first-day invoice still exists', FROZEN?.due_items_snapshot != null && after?.due_items_snapshot != null);
check('  …byte-for-byte unchanged by this slice', after?.due_items_snapshot === FROZEN?.due_items_snapshot);
check('  …still carrying the contradiction, on purpose',
  /Replace\. due at the next service/.test(after?.due_items_snapshot ?? ''),
  'a known artefact of the first day — rewriting it would be the worse error');
check('  …and the pre-floor rating it was measured against',
  /against 9 CCA EN/.test(after?.due_items_snapshot ?? ''));

console.log(`\n${out.filter((c) => c === 'F').length} failures of ${out.length}`);
await prisma.$disconnect();
process.exit(out.includes('F') ? 1 : 0);
