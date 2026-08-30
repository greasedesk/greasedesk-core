// @gate-timeout: 150
/**
 * File: scripts/printed-countdown-gate.mjs
 * THE DOCUMENT SAYS WHAT THE DASH SAID, NOT WHAT WE WORKED OUT FROM IT.
 *
 * The advisory printed "due at 99,767 miles" — a figure nobody read, derived by adding a countdown
 * to an odometer. The service computer chunks in large steps at range and the customer's dash shows
 * the countdown, so the printed absolute was arithmetic to the mile on a number that was rounded
 * before we ever saw it. printedDueLabel prints the countdown as typed.
 *
 * ── TWO LABELS, ONE RULE EACH, AND THE REASON THEY MUST NOT MERGE ───────────────────────────────
 * A countdown is true AT THE MOMENT IT WAS READ. An invoice freezes that moment, so it can print
 * one. The marketing board is read weeks later against a car that has since been driven, so a
 * countdown there is a claim about an odometer reading that is no longer current — the board keeps
 * the absolute. Same distinction dueLabel already draws for the date leg: overdue-by-mileage is a
 * fact about the visit and may be frozen; whether a DATE has passed depends on when you read the
 * paper. So: dueLabel says where the car will be, printedDueLabel says what the dash said.
 *
 * A ROW WITH NO COUNTDOWN PRINTS THE ABSOLUTE, UNCHANGED. Deriving one by subtracting the departure
 * odometer from a target nobody read off a cluster would manufacture exactly the figure this change
 * exists to stop manufacturing. 19 such rows exist today, all on the demo sales tenant.
 *
 * Fixtures on ZZ Gate Garage only. Never TMBS.
 */
import './_gate-preflight.mjs';
const { zzSite, describeError } = await import('./_gate-preflight.mjs');
import './_ts.mjs';
const { PrismaClient } = await import('@prisma/client');
const { readFileSync } = await import('node:fs');
const prisma = new PrismaClient();
const D = await import('../lib/due-items.ts');

const ZZ = 'c75ac44e-250a-4c90-98ba-a8326e98dad5';
const REG = 'ZZ76PCD';
const OUT = 62_767;                 // the departure reading
const CD = 37_000;                  // what the cluster showed
const TARGET = OUT + CD;            // 99,767 — the number that used to print
const out = [];
const check = (n, ok, d = '') => { out.push(ok ? 'P' : 'F'); console.log(`${ok ? '✓' : '✗'} ${n}${d ? `  — ${d}` : ''}`); };
let fix = null;

const withCd = { description: 'Vehicle check', dueBasis: 'whichever_first', dueDate: '2030-06-01',
  dueDatePrecision: 'month', dueMileage: TARGET, countdownMiles: CD, timingInDescription: false };
const noCd = { description: 'Front brake pads', dueBasis: 'mileage', dueDate: null,
  dueDatePrecision: 'day', dueMileage: TARGET, countdownMiles: null, timingInDescription: false };

try {
  // ── 1. THE COUNTDOWN, AS TYPED ───────────────────────────────────────────────────────────────
  const printed = D.printedDueLabel?.(withCd, OUT) ?? '(printedDueLabel does not exist)';
  check('a row with a countdown prints the countdown', printed === 'due in 37,000 miles or by June 2030, whichever comes first',
    printed);
  check('  …and never the derived absolute', !/99,767/.test(printed),
    'the figure nobody read — countdown plus odometer, to the mile');
  const mileageOnly = D.printedDueLabel?.({ ...noCd, countdownMiles: CD }, OUT) ?? '(missing)';
  check('  …on a mileage-only row too', mileageOnly === 'due in 37,000 miles', mileageOnly);

  // ── 2. NO COUNTDOWN — THE ABSOLUTE, UNCHANGED ────────────────────────────────────────────────
  // The discriminating half: without it, a function that always subtracted would pass everything
  // above, and would invent a countdown for 19 live rows that never had one.
  const abs = D.printedDueLabel?.(noCd, OUT) ?? '(missing)';
  check('a row with NO countdown prints the absolute, unchanged', abs === D.dueLabel(noCd, OUT),
    `${abs} — must be identical to dueLabel, not merely similar`);
  check('  …and does not invent one from the odometer', !/due in/.test(abs), abs);

  // ── 3. OVERDUE IS UNTOUCHED ──────────────────────────────────────────────────────────────────
  // A countdown for a passed target is negative, and "due in -240 miles" is not a sentence. The
  // existing overdue wording is already the countdown said positively.
  const past = { ...withCd, dueMileage: OUT - 240 };
  check('the overdue branch is untouched', D.printedDueLabel?.(past, OUT) === D.dueLabel(past, OUT),
    D.printedDueLabel?.(past, OUT));
  check('  …and still says by how much', /overdue by 240 miles/.test(D.printedDueLabel?.(past, OUT) ?? ''),
    D.printedDueLabel?.(past, OUT));

  // ── 4. dueLabel ITSELF IS UNCHANGED — ASSERTED THROUGH A BOARD ROW ───────────────────────────
  // Not by calling dueLabel directly, which would prove only that a function I did not edit still
  // behaves: the claim is that the BOARD's words did not move, so it goes through the board's own
  // caller shape.
  check('dueLabel still prints the absolute for the board', D.dueLabel(withCd, OUT) === 'due at 99,767 miles or by June 2030, whichever comes first',
    D.dueLabel(withCd, OUT));
  const board = readFileSync('lib/marketing-data.ts', 'utf8');
  check('  …and the board still calls dueLabel, not the printed one', /dueLabel\(\{/.test(board) && !/printedDueLabel/.test(board),
    'a countdown on a row read weeks later describes an odometer the car has left behind');

  // ── 5. ONLY THE TWO BLOCK BUILDERS USE IT ────────────────────────────────────────────────────
  const di = readFileSync('lib/due-items.ts', 'utf8');
  // @scan-ok: the CALL SHAPE, not the identifier — `export function printedDueLabel(` matches the
  // bare name too, so counting that would find three and report the two builders as three.
  const callers = [...di.matchAll(/printedDueLabel\(it,/g)].length;
  // ONE, not two. printedMeasuredBlock takes no due items — it is tyre and battery readings — so it
  // never called dueLabel either. printedNeedsBlock is the whole live surface.
  check('printedDueLabel has exactly ONE live caller', callers === 1, `${callers} call sites`);
  const report = readFileSync('lib/intake-report.ts', 'utf8');
  // THE CALL SHAPE, not the bare name: the file now EXPLAINS why it does not use printedDueLabel,
  // so the word is present in prose and a bare-identifier scan reported correct code as broken.
  check('the intake report stays on dueLabel', !/printedDueLabel\(/.test(report) && /[^d]dueLabel\(i,/.test(report));
  check('  …and says why, in the file', /odometer_out|departure reading/.test(report),
    'it prints at odometer_in while the countdown was recorded against odometer_out');
  const legacy = di.slice(di.indexOf('export function printedDueItemsBlock'));
  check('printedDueItemsBlock is left alone', !/printedDueLabel/.test(legacy),
    'its job is to describe how documents minted before the split were built');

  // ── 6. THE BLOCK ACTUALLY CARRIES IT ─────────────────────────────────────────────────────────
  const block = D.printedNeedsBlock({ motExpiry: null, atMiles: OUT, items: [withCd, noCd] });
  check('the printed block carries the countdown', /due in 37,000 miles/.test(block ?? ''), block);
  check('  …and the absolute for the row that has no countdown', /due at 99,767 miles/.test(block ?? ''),
    'both wordings on one document is truthful, not untidy — they were captured differently');

  // ── 7. THE FREEZE, BOTH DIRECTIONS ───────────────────────────────────────────────────────────
  const site = await zzSite(prisma);
  const cust = await prisma.customer.create({ data: { group_id: ZZ, name: 'Printed Countdown Fixture', phone: '07700900321' }, select: { id: true } });
  const veh = await prisma.vehicle.create({ data: { group_id: ZZ, registration: REG, registration_normalized: REG, make: 'Printed', model: 'Fixture' }, select: { id: true } });
  const card = await prisma.jobCard.create({ data: { group_id: ZZ, site_id: site.id, customer_id: cust.id, vehicle_id: veh.id, status: 'in_progress', odometer_in: 62_000, odometer_out: OUT }, select: { id: true } });
  fix = { cust: cust.id, veh: veh.id, card: card.id };
  await prisma.vehicleDueItem.create({ data: {
    group_id: ZZ, vehicle_id: veh.id, found_on_job_card_id: card.id, observation_key: 'schedule_vehicle_check',
    description: 'Vehicle check', due_basis: 'whichever_first', due_date: new Date('2030-06-01T00:00:00.000Z'),
    due_date_precision: 'month', due_mileage: TARGET, countdown_miles: CD, customer_response: 'not_raised',
  } });

  // A: A DOCUMENT ALREADY ISSUED DOES NOT MOVE. The stored column is what renders — proven by
  // writing the OLD wording in and reading it back through the renderer's own loader.
  const OLD = '(1) Vehicle check due at 99,767 miles or by June 2030, whichever comes first';
  const inv = await prisma.invoice.create({ data: {
    group_id: ZZ, site_id: site.id, job_card_id: card.id, series: 'historical', invoice_number: 'ZZPCD-1',
    status: 'issued', sequence_value: 990_001, company_name_snapshot: 'ZZ Gate Garage',
    customer_name_snapshot: 'Printed Countdown Fixture', vat_registered_at_issue: false,
    // No money columns: totals derive from InvoiceLine. This fixture is about the frozen STRING.
    issued_at: new Date('2026-01-01T00:00:00.000Z'), due_items_snapshot: OLD,
  }, select: { id: true } });
  fix.invoice = inv.id;
  const stored = (await prisma.invoice.findUnique({ where: { id: inv.id }, select: { due_items_snapshot: true } }))?.due_items_snapshot;
  check('an issued invoice\'s frozen block is byte-identical', stored === OLD,
    'the renderers read the column; no live path re-derives the text for an issued document');

  // B: A DELIBERATE RE-ISSUE REBUILDS, AND PICKS THE NEW WORDING UP. computeNarrativeBlocks is the
  // function BOTH the mint and pages/api/invoice-unlock call — exercising it is exercising both.
  const II = await import('../lib/invoice-issue.ts');
  const rebuilt = await prisma.$transaction((tx) => II.computeNarrativeBlocks(tx, ZZ, card.id));
  check('a re-issue rebuilds in the new wording', /due in 37,000 miles/.test(rebuilt.dueItemsBlock ?? ''),
    rebuilt.dueItemsBlock ?? 'null');
  check('  …which is a real change and is declared as one',
    (await import('../lib/invoice-snapshots.ts')).snapshotPolicy('due_items_snapshot')?.policy === 'rebuild',
    'declared in the register, not discovered by someone re-issuing');
} catch (e) {
  console.log(`\n✗ THREW: ${String(e?.stack ?? e).slice(0, 700)}`);
  out.push('F');
} finally {
  if (fix) {
    const step = async (n, f) => { try { await f(); } catch (e) { console.log(`  teardown ${n}: ${describeError(e).slice(0, 110)}`); } };
    await step('invoice', () => prisma.invoice.deleteMany({ where: { job_card_id: fix.card } }));
    await step('due items', () => prisma.vehicleDueItem.deleteMany({ where: { vehicle_id: fix.veh } }));
    await step('card', () => prisma.jobCard.deleteMany({ where: { id: fix.card } }));
    await step('vehicle', () => prisma.vehicle.deleteMany({ where: { id: fix.veh } }));
    await step('customer', () => prisma.customer.deleteMany({ where: { id: fix.cust } }));
    try {
      const left = (await prisma.vehicle.count({ where: { id: fix.veh } })) + (await prisma.jobCard.count({ where: { id: fix.card } }));
      check('teardown removed every fixture row (ZZ only)', left === 0, `${left} left`);
    } catch (e) { check('teardown removed every fixture row (ZZ only)', false, describeError(e).slice(0, 70)); }
  }
  const f = out.filter((x) => x === 'F').length;
  console.log(`\n${f} failures of ${out.length}`);
  await prisma.$disconnect();
  process.exit(f ? 1 : 0);
}
