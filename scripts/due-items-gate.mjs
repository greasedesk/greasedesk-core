/**
 * File: scripts/due-items-gate.mjs
 * A FINDING SURVIVES THE JOB IT WAS FOUND ON, and the three-state answer cannot be defaulted away.
 *
 * Fixtures on ZZ Gate Garage only. Never TMBS. Throwaway rows, removed here.
 */
import './_gate-preflight.mjs';
import './_ts.mjs';
const { prisma } = await import('../lib/db.ts');
const { refuseDueItem, responseAtFor, openDueItemsForVehicle, dueLabel } = await import('../lib/due-items.ts');
const { readFileSync } = await import('node:fs');

const ZZ = 'c75ac44e-250a-4c90-98ba-a8326e98dad5';
const out = [];
const check = (n, ok, d = '') => { out.push(ok ? 'P' : 'F'); console.log(`${ok ? '✓' : '✗'} ${n}${d ? `  — ${d}` : ''}`); };
const OK = { description: 'Front discs and pads', dueBasis: 'mileage', dueMileage: 60000, customerResponse: 'declined' };

// ── 1. THE REFUSALS — a MISSING DECISION, not a missing value ───────────────────────────────────
console.log('\n— the rule can fail —');
check('accepts a complete finding', refuseDueItem(OK) === null);
for (const [label, patch, code] of [
  ['no description', { description: '  ' }, 'no_description'],
  ['NO BASIS CHOSEN — the decision, not the data', { dueBasis: undefined }, 'no_basis'],
  ['basis=date with no date', { dueBasis: 'date', dueDate: null }, 'no_date'],
  ['basis=mileage with no mileage', { dueBasis: 'mileage', dueMileage: null }, 'no_mileage'],
  ['NO RESPONSE CHOSEN — the one that protects the lead list', { customerResponse: undefined }, 'no_response'],
  ['a response outside the three', { customerResponse: 'maybe' }, 'no_response'],
]) {
  const r = refuseDueItem({ ...OK, ...patch });
  check(`refuses ${label}`, r?.code === code, r ? r.code : 'ACCEPTED IT');
}
// THE DISCRIMINATOR: a date AND a mileage both present is legal — the basis decides, so the
// presence of data must not be able to stand in for the decision.
check('a date AND a mileage together is fine — the basis binds, not the data',
  refuseDueItem({ ...OK, dueBasis: 'date', dueDate: new Date('2027-03-01'), dueMileage: 60000 }) === null,
  '"by March, or 60k, whichever first" is a real thing a mechanic says');

// ── 2. not_raised IS AN ABSENCE, NOT AN ANSWER AT TIME-UNKNOWN ─────────────────────────────────
console.log('\n— response_at follows the response —');
const now = new Date('2026-08-19T10:00:00Z');
check('not_raised leaves response_at NULL', responseAtFor('not_raised', now) === null,
  'nobody answered — an absence of an event, not an event we failed to time');
check('declined stamps it', responseAtFor('declined', now) === now);
check('agreed_later stamps it', responseAtFor('agreed_later', now) === now);

// ── 3. NO DEFAULT ANYWHERE IN THE STACK ────────────────────────────────────────────────────────
console.log('\n— the three-state answer cannot be defaulted away —');
const schema = readFileSync('prisma/schema.prisma', 'utf8');
const model = schema.slice(schema.indexOf('model VehicleDueItem'), schema.indexOf('model Vehicle {'));
check('the COLUMN has no default', /customer_response DueItemResponse\s*$/m.test(model),
  'a @default(not_raised) would make the refusal above unreachable from the database side');
check('and neither does due_basis', /due_basis   DueBasis\s*$/m.test(model));
const ui = readFileSync('components/jobcard/DueItems.tsx', 'utf8');
check('the capture UI starts with NOTHING selected', /useState<typeof RESPONSES\[number\] \| null>\(null\)/.test(ui),
  'a pre-selected radio is how declined would quietly stop happening');
check('  …and Save is disabled until someone chooses', /response !== null/.test(ui));
const api = readFileSync('pages/api/due-items.ts', 'utf8');
check('the API refuses through the SAME predicate, so a forgetful client cannot write a defaulted row',
  /refuseDueItem\(\{/.test(api) && /if \(refusal\) return res\.status\(400\)/.test(api));

// ── 4. THE CUSTOMER IS NOT ON THE RECORD ───────────────────────────────────────────────────────
console.log('\n— who to remind is resolved later, never stored —');
check('the model has no customer column', !/customer_id/.test(model),
  'the car may change hands between the finding and the reminder');
check('  …and no customer relation either', !/Customer/.test(model));
check('the reasoning is recorded where the next reader will be', /never stored, never joined|NEVER STORED HERE|not part of the record/i.test(readFileSync('lib/due-items.ts', 'utf8') + model));

// ── 5. LIVE ON ZZ: it outlives the card ────────────────────────────────────────────────────────
console.log('\n— throwaway fixtures on ZZ Gate Garage —');
let fix = null;
try {
  const site = await prisma.site.findFirst({ where: { group_id: ZZ }, select: { id: true } });
  const veh = await prisma.vehicle.create({ data: { group_id: ZZ, registration: 'ZZ94 DUE', registration_normalized: 'ZZ94DUE' }, select: { id: true } });
  const card = await prisma.jobCard.create({ data: { group_id: ZZ, site_id: site.id, vehicle_id: veh.id, status: 'draft' }, select: { id: true } });
  fix = { vehId: veh.id, cardId: card.id, itemIds: [] };
  const item = await prisma.vehicleDueItem.create({
    data: {
      group_id: ZZ, vehicle_id: veh.id, found_on_job_card_id: card.id,
      description: 'gate: front discs', due_basis: 'mileage', due_mileage: 60000,
      customer_response: 'declined', response_at: new Date(),
    },
    select: { id: true },
  });
  fix.itemIds.push(item.id);

  let open = await openDueItemsForVehicle(prisma, ZZ, veh.id);
  check('the surfacing read returns it', open.length === 1 && open[0].description === 'gate: front discs');
  check('  …with the timing in words', dueLabel(open[0]) === 'due at 60,000 miles', dueLabel(open[0]));
  check('  …and the response, so the lead is visible', open[0].customerResponse === 'declined');

  // THE POINT OF THE WHOLE MODEL: delete the job it was found on; the finding survives.
  await prisma.jobCard.delete({ where: { id: card.id } });
  fix.cardId = null;
  const after = await prisma.vehicleDueItem.findUnique({ where: { id: item.id }, select: { found_on_job_card_id: true } });
  check('DELETING THE CARD does not delete the finding', after !== null,
    'the finding is about the CAR — that is why it is keyed to the vehicle');
  check('  …and the provenance goes NULL rather than dangling', after?.found_on_job_card_id === null,
    'SetNull, not Cascade');
  open = await openDueItemsForVehicle(prisma, ZZ, veh.id);
  check('  …and it still surfaces on the car', open.length === 1);

  // Closing it removes it from the surface, with no status column to disagree with the timestamp.
  await prisma.vehicleDueItem.update({ where: { id: item.id }, data: { closed_at: new Date() } });
  check('a closed item stops surfacing', (await openDueItemsForVehicle(prisma, ZZ, veh.id)).length === 0);
  check('the check is discriminating — the row is still THERE, just closed',
    (await prisma.vehicleDueItem.count({ where: { id: item.id } })) === 1, 'history is kept; only the surface changes');
} catch (e) {
  check('fixture run completed', false, String(e?.message ?? e).slice(0, 300));
} finally {
  if (fix) {
    await prisma.vehicleDueItem.deleteMany({ where: { id: { in: fix.itemIds } } });
    if (fix.cardId) await prisma.jobCard.delete({ where: { id: fix.cardId } }).catch(() => {});
    await prisma.vehicle.delete({ where: { id: fix.vehId } }).catch(() => {});
    const left = await prisma.vehicleDueItem.count({ where: { id: { in: fix.itemIds } } })
      + await prisma.vehicle.count({ where: { id: fix.vehId } });
    check('teardown removed every fixture row (audit rows stay — append-only)', left === 0, `${left} left`);
  }
}

console.log(`\n${out.filter((c) => c === 'F').length} failures of ${out.length}`);
await prisma.$disconnect();
process.exit(out.includes('F') ? 1 : 0);
