/**
 * File: scripts/observations-gate.mjs
 * QUICK OBSERVATIONS — and the discipline that keeps them observations.
 *
 * The rule "describe what was seen, never name the cause" is a stated discipline, so it is enforced
 * here against every description in the catalogue rather than trusted to whoever adds the next one.
 * A convention nobody checks is a convention that lasts until the first hurried afternoon.
 *
 * Fixtures on ZZ Gate Garage only. Never TMBS.
 */
import './_gate-preflight.mjs';
const { explainIfClientStale } = await import('./_gate-preflight.mjs');
import './_ts.mjs';
const { PrismaClient } = await import('@prisma/client');
const O = await import('../lib/observations.ts');
const K = await import('../lib/observation-keys.ts');
const { readFileSync } = await import('node:fs');
const prisma = new PrismaClient();

const { chromium } = await import('/Users/hugh/Developer/greasedesk-core/node_modules/playwright-core/index.mjs');
const ZZ = 'c75ac44e-250a-4c90-98ba-a8326e98dad5';
const BASE = process.env.GATE_BASE ?? 'http://localhost:3000';
const out = [];
const check = (n, ok, d = '') => { out.push(ok ? 'P' : 'F'); console.log(`${ok ? '✓' : '✗'} ${n}${d ? `  — ${d}` : ''}`); };

let fix = null, browser = null;

try {
  // ── 1. OBSERVATION, NEVER DIAGNOSIS ──────────────────────────────────────────────────────────
  console.log('\n— describe what was seen, never name the cause —');
  // Words that assert a CAUSE or prescribe a REMEDY. Note what is absent: "split", "smearing",
  // "discoloured", "not working" are all things a person can see, and they are allowed.
  const DIAGNOSIS = /\b(worn|faulty|failed|failure|defective|seized|perished|needs? (replacing|changing|renewing)|replace|renew)\b/i;
  const offenders = O.OBSERVATIONS.filter((o) => DIAGNOSIS.test(o.description));
  check('no catalogue description names a cause or prescribes a remedy', offenders.length === 0,
    offenders.map((o) => `${o.key}: ${o.description}`).join(' | ') || 'all seventeen describe, none diagnose');
  check('  …and the labels are clean too', O.OBSERVATIONS.every((o) => !DIAGNOSIS.test(o.label)));
  // THE SCANNER MUST BE ABLE TO FIRE. A pattern that matches nothing proves nothing.
  check('  …and the scanner catches a diagnosis when there is one',
    DIAGNOSIS.test('Clutch worn') && DIAGNOSIS.test('Wipers need replacing') && !DIAGNOSIS.test('Clutch biting point is high'));

  const src = readFileSync('lib/observations.ts', 'utf8');
  const prose = src.replace(/^\s*\*\s?/gm, ' ').replace(/\s+/g, ' ');
  check('the boundary against lib/battery is written down',
    /a MEASUREMENT earns the right to advise/i.test(prose),
    'battery says "replace" because a number crossed a threshold; an observation has neither');

  // ── 2. THE BASIS IS AUTHORED, NOT DEFAULTED ──────────────────────────────────────────────────
  console.log('\n— it looks like a default and is not —');
  check('every entry states its own basis', O.OBSERVATIONS.every((o) => typeof o.basis === 'string' && o.basis.length > 0));
  check('  …and the file says why that is different from a default',
    /That looks exactly like a default and is not/i.test(prose));
  // COMMENTS STRIPPED FIRST. The header of lib/observations explains at length that the response is
  // deliberately absent, using the very words this scan looks for — so the naive version matched the
  // explanation of the rule and reported the rule broken. Scan the CODE, then assert separately that
  // the explanation is still there, or removing the reasoning would silently pass.
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  check('the ANSWER is nowhere in the catalogue itself', !/not_raised|customerResponse|declined/.test(code),
    'a default response would delete the only answer that is a lead');
  check('  …and the reason it is absent is still written down',
    /the only response that is a lead/i.test(prose) && /would never appear/i.test(prose));

  // ── 3. TWO KEYS FOR THE BITING POINT ─────────────────────────────────────────────────────────
  console.log('\n— £600 and £150 are not two values of one thing —');
  check('high and low are separate observations',
    O.observationByKey('clutch_biting_high') != null && O.observationByKey('clutch_biting_low') != null);
  check('  …with different descriptions',
    O.observationByKey('clutch_biting_high').description !== O.observationByKey('clutch_biting_low').description);
  check('  …and neither says which part is at fault',
    !/clutch (worn|wear)|master cylinder|slave|hydraulic/i.test(
      O.observationByKey('clutch_biting_high').description + O.observationByKey('clutch_biting_low').description));

  // ── 4. EIGHT BULBS, NOT SIXTEEN CELLS ────────────────────────────────────────────────────────
  console.log('\n— read off a job sheet, not imagined from the axes —');
  check('eight bulb positions', O.bulbMembers().length === 8, O.bulbMembers().map((o) => o.label).join(', '));
  check('  …each carrying its position IN THE KEY, so it counts',
    O.bulbMembers().every((o) => o.key.startsWith('bulb_') && o.key.length > 'bulb_'.length));
  check('  …and none of them appears at the top level', O.TOP_LEVEL.every((o) => o.group !== 'bulb'));
  check('the parent is a label, not an entry', O.observationByKey('bulb') === null,
    'there is no key that could save a finding saying only "bulb out"');

  // ── 5. KEYS ARE UNIQUE AND DO NOT COLLIDE WITH THE MACHINE SPACE ─────────────────────────────
  console.log('\n— one key space, shared with the measurements —');
  check('every key is unique', new Set(O.OBSERVATIONS.map((o) => o.key)).size === O.OBSERVATIONS.length);
  const collisions = [...O.OBSERVATION_KEYS].filter((k) => K.isMachineObservationKey(k));
  check('no observation key collides with a machine one', collisions.length === 0,
    collisions.join(', ') || 'tyre_depth_*, tyre_alignment and battery stay the writers’ own');

  // ── 6. THE ORDERING IS THE FEATURE, NOT POLISH ───────────────────────────────────────────────
  console.log('\n— seventeen chips in authored order is a visual search —');
  const cold = O.orderObservations({});
  check('with no history at all, the cold-start order stands', cold[0].key === O.TOP_LEVEL[0].key);
  const used = O.orderObservations({ oil_leak_gearbox: 40, handbrake_travel: 12 });
  check('a garage’s own most-used floats to the top', used[0].key === 'oil_leak_gearbox' && used[1].key === 'handbrake_travel',
    used.slice(0, 3).map((o) => o.key).join(' → '));
  // Pins the OUTCOME, not the tie-break line: sort stability guarantees this too, so deleting the
  // explicit rank leaves the gate green. Said plainly rather than left to imply otherwise.
  check('  …and ties keep the authored order (guaranteed twice: the rank, and a stable sort)',
    O.orderObservations({ oil_leak_engine: 5, oil_leak_gearbox: 5 })
      .filter((o) => o.key.startsWith('oil_leak_')).map((o) => o.key).join(',') === 'oil_leak_engine,oil_leak_gearbox');
  check('the bulb group ranks on its members combined', O.bulbUsage({ bulb_ns_headlight: 3, bulb_brake_light: 4 }) === 7);
  // THE DEFECT THAT SHIPPED IN THE FIRST DRAFT: with every count at zero, nothing was "used less
  // often" than the group, so it sorted to position eighteen and sat behind More on day one — one
  // of the commonest things in a workshop, hidden. An authored cold-start rank is what fixes it.
  const cold2 = O.orderedTapList({});
  const coldBulb = cold2.findIndex(O.isBulbTap);
  check('on day one the bulb group is ABOVE the fold, not behind More',
    coldBulb >= 0 && coldBulb < O.VISIBLE_BEFORE_MORE, `position ${coldBulb + 1} of ${cold2.length}`);
  // Two cases, because "it ranks on usage" is only shown by it moving BOTH ways.
  const many = O.orderedTapList({ oil_leak_gearbox: 40, bulb_ns_headlight: 30, bulb_brake_light: 25 });
  check('  …and 55 bulbs outranks 40 oil leaks', many.findIndex(O.isBulbTap) === 0,
    `position ${many.findIndex(O.isBulbTap) + 1} — the members are summed, so the group competes on the total`);
  const few = O.orderedTapList({ oil_leak_gearbox: 40, handbrake_travel: 20, bulb_ns_headlight: 5 });
  check('  …and 5 bulbs sits below both of them, not at its authored slot',
    few.findIndex(O.isBulbTap) === 2, `position ${few.findIndex(O.isBulbTap) + 1}`);
  check('one ordering rule, not one per surface',
    !/bulbUsage\(counts\)/.test(readFileSync('components/pwa/PhoneObservations.tsx', 'utf8'))
    && !/bulbUsage\(counts\)/.test(readFileSync('components/jobcard/ObservationTaps.tsx', 'utf8')),
    'it was written out on both surfaces, which is two chances to disagree');
  check('  …and an unused catalogue still fits above the fold', O.VISIBLE_BEFORE_MORE === 6);

  // ── 7. AGAINST THE DATABASE: ONE TAP, ONE FINDING, REPLAY-SAFE ───────────────────────────────
  console.log('\n— a tap on a throwaway car —');
  const site = await prisma.site.findFirst({ where: { group_id: ZZ }, select: { id: true } });
  const veh = await prisma.vehicle.create({ data: { group_id: ZZ, registration: 'ZZ76OBS', make: 'Observe', model: 'Fixture' }, select: { id: true } });
  const card = await prisma.jobCard.create({ data: { group_id: ZZ, site_id: site.id, vehicle_id: veh.id, status: 'draft' }, select: { id: true } });
  fix = { veh: veh.id, card: card.id };

  const wipers = O.observationByKey('wipers_smearing');
  const mk = (key, desc, basis) => prisma.vehicleDueItem.create({
    data: {
      group_id: ZZ, vehicle_id: veh.id, found_on_job_card_id: card.id,
      observation_key: key, description: desc, due_basis: basis, customer_response: 'declined', response_at: new Date(),
    },
    select: { id: true },
  });
  await mk(wipers.key, wipers.description, wipers.basis);

  // THE REPLAY. The endpoint finds the open row rather than stacking — proven here against the
  // constraint itself, so the guarantee does not depend on the endpoint remembering to look.
  let refused = false;
  try { await mk(wipers.key, wipers.description, wipers.basis); } catch { refused = true; }
  check('the same observation cannot be recorded twice while it is open', refused,
    'which is what makes the phone’s queue replay-safe with no client id');

  const rows = await prisma.vehicleDueItem.findMany({ where: { vehicle_id: veh.id }, select: { description: true, observation_key: true, due_basis: true, timing_in_description: true } });
  check('one tap, one finding', rows.length === 1 && rows[0].observation_key === 'wipers_smearing');
  check('  …carrying the catalogue’s own words', rows[0].description === 'Wiper blades smearing');
  check('  …and the basis the entry authored', rows[0].due_basis === wipers.basis);
  check('  …with the timing left to the basis, not the words', rows[0].timing_in_description === false,
    'every catalogue entry is a plain noun phrase today');

  // It reaches the printed block for free — the whole argument for reusing VehicleDueItem.
  const { printedDueItemsBlock, openDueItemsForVehicle } = await import('../lib/due-items.ts');
  const open = await openDueItemsForVehicle(prisma, ZZ, veh.id);
  check('an observation carries its key out of the surfacing read', open[0]?.observationKey === 'wipers_smearing');
  const block = printedDueItemsBlock({ motExpiry: null, items: open });
  check('  …and reaches the frozen invoice block with no new plumbing',
    block === '(1) Wiper blades smearing due at the next service', JSON.stringify(block));
  // ── 8. ON THE SERVED DESKTOP PAGE ────────────────────────────────────────────────────────────
  // The phone surface is proven in scripts/phone-capture-timing. This is the other one, and leaving
  // it unproven twice — battery, then this — was the gap worth closing rather than repeating: the
  // pure rules can be perfect while the panel never renders, and a static read of the JSX proves
  // only that the file mentions it.
  console.log('\n— the tap-list, on the page a service advisor uses —');
  browser = await chromium.launch({ channel: 'chrome' });
  const page = await (await browser.newContext()).newPage();
  await page.goto(`${BASE}/admin/login`, { waitUntil: 'domcontentloaded' });
  await page.fill('input[type="email"]', 'owner@zzgategarage.test');
  await page.fill('input[type="password"]', 'GateGarage!2026');
  await Promise.all([page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 60000 }), page.click('button[type="submit"]')]);

  // A SECOND car, because the fixture above already holds an open wipers item and the tap-list
  // correctly disables an observation already recorded. Testing against that would prove the
  // disabling, not the tap.
  const dVeh = await prisma.vehicle.create({ data: { group_id: ZZ, registration: 'ZZ76DSK', make: 'Desk', model: 'Fixture' }, select: { id: true } });
  // stage_details_done, because Intake is GATED behind Details (lib/jobcard-tabs) and a card that
  // has not got past step one cannot show step two. Set directly as fixture setup: it is the state
  // a real card reaches, and the gating itself is proven in its own gate rather than re-proven here.
  const dCard = await prisma.jobCard.create({
    data: { group_id: ZZ, site_id: site.id, vehicle_id: dVeh.id, status: 'in_progress', stage_details_done: true },
    select: { id: true },
  });
  fix.deskVeh = dVeh.id; fix.deskCard = dCard.id;

  await page.goto(`${BASE}/admin/jobcards/${dCard.id}`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: 'Intake', exact: false }).first().click();
  await page.waitForSelector('[data-testid="observation-taps"]', { timeout: 25000 });
  check('the tap-list renders on the served Intake tab', true);

  // THE COLD-START ORDERING, ON THE PAGE. ZZ has no observation history, so this is the day-one
  // view — the case where the bulb group was hiding behind "More".
  // THE EXACT SET, not a count. A prefix count also matched the bulb-group and More buttons and
  // reported seven — a number that says nothing about which six a mechanic can actually see.
  const cold3 = O.orderedTapList({});
  const tid = (e) => O.isBulbTap(e) ? 'observation-bulb-group' : `observation-${e.key}`;
  const shouldSee = cold3.slice(0, O.VISIBLE_BEFORE_MORE).map(tid);
  const shouldNot = cold3.slice(O.VISIBLE_BEFORE_MORE).map(tid);
  const seen = [];
  for (const t of shouldSee) if (await page.locator(`[data-testid="${t}"]`).count() === 1) seen.push(t);
  check('  …showing exactly the six the ordering chose', seen.length === shouldSee.length,
    `${seen.length} of ${shouldSee.length}: ${shouldSee.join(', ')}`);
  check('  …and none of the other twelve until More is pressed',
    (await page.locator(`[data-testid="${shouldNot[0]}"]`).count()) === 0
    && (await page.locator(`[data-testid="${shouldNot[shouldNot.length - 1]}"]`).count()) === 0,
    `${shouldNot.length} held back`);
  check('  …with the bulb group among the six on day one',
    shouldSee.includes('observation-bulb-group') && await page.locator('[data-testid="observation-bulb-group"]').count() === 1,
    'the defect this caught was it sorting to position eighteen, behind More');
  check('  …and More offers the rest', /More \(/.test(await page.locator('[data-testid="observation-more"]').innerText()));

  // TWO TAPS, on the real page.
  await page.locator('[data-testid="observation-wipers_smearing"]').click();
  await page.waitForSelector('[data-testid="observation-answer"]', { timeout: 15000 });
  check('choosing an observation asks the one question that has no default',
    await page.locator('[data-testid="observation-answer-declined"]').count() === 1);
  await page.locator('[data-testid="observation-answer-declined"]').click();
  await page.waitForSelector('[data-testid="observation-saved"]', { timeout: 20000 });

  const landed = await prisma.vehicleDueItem.findFirst({
    where: { vehicle_id: dVeh.id }, select: { observation_key: true, description: true, customer_response: true, due_basis: true },
  });
  check('two taps put a finding on the car', landed?.observation_key === 'wipers_smearing', JSON.stringify(landed));
  check('  …in the catalogue’s words, with nothing typed', landed?.description === 'Wiper blades smearing');
  check('  …carrying the answer chosen, not a default', landed?.customer_response === 'declined');

  // AND IT SHOWS AS DONE, so the same tap is not offered twice.
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: 'Intake', exact: false }).first().click();
  await page.waitForSelector('[data-testid="observation-taps"]', { timeout: 25000 });
  check('an observation already on the car is not offered again',
    await page.locator('[data-testid="observation-wipers_smearing"]').isDisabled(),
    'tapping it would be a no-op the endpoint absorbs — better not to offer it');

} catch (e) {
  check('gate run completed', false, String(e?.message ?? e).slice(0, 300));
  await explainIfClientStale(BASE);
} finally {
  if (browser) await browser.close().catch(() => {});
  if (fix) {
    const step = async (n, f) => { try { await f(); } catch (e) { console.log(`  teardown ${n}: ${String(e?.message ?? e).slice(0, 90)}`); } };
    // AuditLog is append-only. Its rows for this card stay, correctly.
    const vehIds = [fix.veh, fix.deskVeh].filter(Boolean);
    const cardIds = [fix.card, fix.deskCard].filter(Boolean);
    await step('due items', () => prisma.vehicleDueItem.deleteMany({ where: { vehicle_id: { in: vehIds } } }));
    await step('cards', () => prisma.jobCard.deleteMany({ where: { id: { in: cardIds } } }));
    await step('vehicles', () => prisma.vehicle.deleteMany({ where: { id: { in: vehIds } } }));
    check('teardown removed every fixture row',
      (await prisma.vehicle.count({ where: { id: { in: vehIds } } })) === 0
      && (await prisma.vehicleDueItem.count({ where: { vehicle_id: { in: vehIds } } })) === 0
      && (await prisma.jobCard.count({ where: { id: { in: cardIds } } })) === 0);
  }
}

console.log(`\n${out.filter((c) => c === 'F').length} failures of ${out.length}`);
await prisma.$disconnect();
process.exit(out.includes('F') ? 1 : 0);
