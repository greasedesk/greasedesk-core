/**
 * File: scripts/observation-key-gate.mjs
 * A MACHINE WRITER MUST NEVER FIND A HUMAN'S FINDING.
 *
 * Both measurement writers used to locate their own open item by description PREFIX. That also
 * matched prose: "Battery terminals corroded" starts with "Battery", so the next battery test
 * UPDATED the mechanic's own observation into a battery advisory — no error, no trace, a genuine
 * finding simply became a different one.
 *
 * These assertions are about the shape of that failure, not the strings involved: a writer looks
 * for its own KEY, prose has no key, and a car can hold only one open item per observation because
 * the database says so rather than because the writers are careful.
 *
 * Fixtures on ZZ Gate Garage only. Never TMBS.
 */
import './_gate-preflight.mjs';
const { gatePrisma, zzSite, describeError } = await import('./_gate-preflight.mjs');
import './_ts.mjs';
const T = await import('../lib/tyres.ts');
const B = await import('../lib/battery.ts');
const K = await import('../lib/observation-keys.ts');
const prisma = await gatePrisma();

const ZZ = 'c75ac44e-250a-4c90-98ba-a8326e98dad5';
const out = [];
const check = (n, ok, d = '') => { out.push(ok ? 'P' : 'F'); console.log(`${ok ? '✓' : '✗'} ${n}${d ? `  — ${d}` : ''}`); };
const D = (o, c, i) => ({ outer: o, centre: c, inner: i });
const SEPT = new Date('2026-09-15T00:00:00Z');

let fix = null;

try {
  const site = await zzSite(prisma);
  const veh = await prisma.vehicle.create({ data: { group_id: ZZ, registration: 'ZZ76KEY', make: 'Key', model: 'Fixture' }, select: { id: true } });
  const card = await prisma.jobCard.create({ data: { group_id: ZZ, site_id: site.id, vehicle_id: veh.id, status: 'draft', odometer_in: 50000 }, select: { id: true } });
  fix = { veh: veh.id, card: card.id };

  // ── 1. THE TWO FINDINGS A MECHANIC MIGHT ACTUALLY TYPE ──────────────────────────────────────
  // Chosen because each begins with exactly the prefix its writer used to search for. Anchored on
  // the collision, not merely plausible-sounding.
  console.log('\n— prose that starts with a machine’s own words —');
  const human = [];
  for (const desc of ['Battery terminals corroded', 'Rear left brake pad low']) {
    const r = await prisma.vehicleDueItem.create({
      data: {
        group_id: ZZ, vehicle_id: veh.id, found_on_job_card_id: card.id,
        description: desc, due_basis: 'next_service', customer_response: 'not_raised',
      },
      select: { id: true, description: true, observation_key: true },
    });
    human.push(r);
  }
  check('a hand-typed finding carries NO key', human.every((h) => h.observation_key === null),
    'null means a human typed it — the meaningful absence, not a gap');

  // ── 2. THE WRITERS RUN OVER THE TOP OF THEM ─────────────────────────────────────────────────
  console.log('\n— then the car is measured —');
  await prisma.$transaction((tx) => B.recordBatteryReading(tx, {
    groupId: ZZ, vehicleId: veh.id, jobCardId: card.id, measuredBy: null,
    reading: { voltageMv: 12550, socPct: 92, sohPct: 44, ratedCca: 700, ccaStandard: 'EN' }, measuredAt: SEPT,
  }));
  await prisma.$transaction((tx) => T.recordTyreReadings(tx, {
    groupId: ZZ, vehicleId: veh.id, jobCardId: card.id, measuredBy: null, odometer: 50000,
    corners: [{ corner: 'rear_left', type: 'summer_standard', depths: D(20, 20, 20) }],
  }));

  const after = await Promise.all(human.map((h) =>
    prisma.vehicleDueItem.findUnique({ where: { id: h.id }, select: { description: true, observation_key: true } })));
  check('the mechanic’s battery note is untouched', after[0]?.description === 'Battery terminals corroded',
    after[0]?.description ?? 'ROW GONE');
  check('the mechanic’s brake note is untouched', after[1]?.description === 'Rear left brake pad low',
    after[1]?.description ?? 'ROW GONE');
  check('  …and neither was given a key by a writer that grabbed it',
    after.every((a) => a?.observation_key === null));

  const all = await prisma.vehicleDueItem.findMany({ where: { vehicle_id: veh.id }, select: { description: true, observation_key: true } });
  check('the advisories landed as their OWN rows', all.length === 4, `${all.length} findings: ${all.map((a) => a.observation_key ?? 'free-text').join(', ')}`);
  check('  …keyed, so they are countable across a book',
    all.filter((a) => a.observation_key === K.BATTERY_KEY).length === 1
    && all.filter((a) => a.observation_key === K.tyreDepthKey('rear_left')).length === 1);

  // ── 3. THE ORIGINAL BEHAVIOUR IS PRESERVED ──────────────────────────────────────────────────
  // The prefix matching existed for a reason: re-measuring must correct, not stack. Fixing the
  // collision must not cost that, or the repair is a regression wearing a fix's clothes.
  console.log('\n— re-measuring still corrects rather than stacks —');
  await prisma.$transaction((tx) => T.recordTyreReadings(tx, {
    groupId: ZZ, vehicleId: veh.id, jobCardId: card.id, measuredBy: null, odometer: 50000,
    corners: [{ corner: 'rear_left', type: 'summer_standard', depths: D(18, 18, 18) }],
  }));
  await prisma.$transaction((tx) => B.recordBatteryReading(tx, {
    groupId: ZZ, vehicleId: veh.id, jobCardId: card.id, measuredBy: null,
    reading: { voltageMv: 12500, socPct: 90, sohPct: 38 }, measuredAt: SEPT,
  }));
  const after2 = await prisma.vehicleDueItem.count({ where: { vehicle_id: veh.id } });
  check('still four findings, corrected in place', after2 === 4, `${after2} findings`);

  // ── 4. ALIGNMENT IS ONE JOB FOR THE CAR ─────────────────────────────────────────────────────
  console.log('\n— nobody sells four alignments —');
  await prisma.$transaction((tx) => T.recordTyreReadings(tx, {
    groupId: ZZ, vehicleId: veh.id, jobCardId: card.id, measuredBy: null, odometer: 50000,
    corners: [
      { corner: 'front_left', type: 'summer_standard', depths: D(60, 40, 20) },
      { corner: 'front_right', type: 'summer_standard', depths: D(60, 40, 20) },
    ],
  }));
  const align = await prisma.vehicleDueItem.count({ where: { vehicle_id: veh.id, observation_key: K.TYRE_ALIGNMENT_KEY, closed_at: null } });
  check('two misaligned corners raise ONE alignment item', align === 1,
    `${align} — four open items for one tracking job would read as four things to fix`);
  const depths = await prisma.vehicleDueItem.count({ where: { vehicle_id: veh.id, observation_key: { startsWith: 'tyre_depth_' }, closed_at: null } });
  check('  …but worn tyres stay per-corner, because a garage sells one at a time', depths === 3,
    `${depths} depth items`);

  // ── 5. A CONSTRAINT, NOT A CONVENTION ───────────────────────────────────────────────────────
  console.log('\n— the database refuses the duplicate, not the writer —');
  let refused = false;
  try {
    await prisma.vehicleDueItem.create({
      data: {
        group_id: ZZ, vehicle_id: veh.id, observation_key: K.BATTERY_KEY,
        description: 'A second open battery item', due_basis: 'next_service', customer_response: 'not_raised',
      },
    });
  } catch { refused = true; }
  check('a second OPEN item with the same key is impossible', refused,
    'a future writer that forgets to update-in-place fails loudly instead of stacking');

  let freeTextOk = true;
  try {
    await prisma.vehicleDueItem.createMany({
      data: [
        { group_id: ZZ, vehicle_id: veh.id, description: 'Something odd underneath', due_basis: 'next_service', customer_response: 'not_raised' },
        { group_id: ZZ, vehicle_id: veh.id, description: 'Something else odd', due_basis: 'next_service', customer_response: 'not_raised' },
      ],
    });
  } catch { freeTextOk = false; }
  check('  …but two free-text findings coexist', freeTextOk,
    'a car can need two things nobody had a word for — the index is partial on purpose');

  // A CLOSED item does not block the next one: history repeats, and it must be allowed to.
  await prisma.vehicleDueItem.updateMany({
    where: { vehicle_id: veh.id, observation_key: K.BATTERY_KEY }, data: { closed_at: new Date() },
  });
  let reopened = true;
  try {
    await prisma.vehicleDueItem.create({
      data: {
        group_id: ZZ, vehicle_id: veh.id, observation_key: K.BATTERY_KEY,
        description: 'Battery advisory, a year later', due_basis: 'next_service', customer_response: 'not_raised',
      },
    });
  } catch { reopened = false; }
  check('  …and a CLOSED item never blocks the same observation next year', reopened);
} catch (e) {
  check('gate run completed', false, describeError(e).slice(0, 300));
} finally {
  if (fix) {
    const step = async (n, f) => { try { await f(); } catch (e) { console.log(`  teardown ${n}: ${describeError(e).slice(0, 90)}`); } };
    // AuditLog is append-only. Its rows for this card stay, correctly.
    await step('readings', () => prisma.tyreReading.deleteMany({ where: { vehicle_id: fix.veh } }));
    await step('battery', () => prisma.batteryReading.deleteMany({ where: { vehicle_id: fix.veh } }));
    await step('due items', () => prisma.vehicleDueItem.deleteMany({ where: { vehicle_id: fix.veh } }));
    await step('card', () => prisma.jobCard.deleteMany({ where: { id: fix.card } }));
    await step('vehicle', () => prisma.vehicle.delete({ where: { id: fix.veh } }));
    check('teardown removed every fixture row',
      (await prisma.vehicle.count({ where: { id: fix.veh } })) === 0
      && (await prisma.vehicleDueItem.count({ where: { vehicle_id: fix.veh } })) === 0);
  }
}

console.log(`\n${out.filter((c) => c === 'F').length} failures of ${out.length}`);
await prisma.$disconnect();
process.exit(out.includes('F') ? 1 : 0);
