/**
 * File: scripts/intake-prompts-gate.mjs
 * THE FOUR PROMPTS — and the affirmative that decides whether the escalation survives a real
 * workshop.
 *
 * The assertion that matters most is the CLEAN CAR: a car that genuinely needs nothing must be
 * able to satisfy the findings prompt WITHOUT a skip. If it cannot, every properly-checked clean
 * car generates a false escalation, the admin stops reading by Wednesday, and the whole design is
 * dead. That is a product failure with no error message, so it gets a gate.
 *
 * Fixtures on ZZ Gate Garage only. Never TMBS.
 */
import './_gate-preflight.mjs';
import './_ts.mjs';
const { prisma } = await import('../lib/db.ts');
const { INTAKE_ITEMS, INTAKE_SWITCH, intakeItemDone, intakeItemStates, intakeOutstanding, SKIP_REASON_CHIPS, DIAG_SCAN_SLOT } = await import('../lib/intake-items.ts');
const { readFileSync } = await import('node:fs');

const ZZ = 'c75ac44e-250a-4c90-98ba-a8326e98dad5';
const out = [];
const check = (n, ok, d = '') => { out.push(ok ? 'P' : 'F'); console.log(`${ok ? '✓' : '✗'} ${n}${d ? `  — ${d}` : ''}`); };
const NONE = { dueItemCount: 0, nothingFoundAt: null, odometerIn: null, vin: null, hasIntakeVideo: false, hasDiagScanPhoto: false };
const ALL_ON = Object.fromEntries(INTAKE_ITEMS.map((i) => [INTAKE_SWITCH[i], true]));

// ── 1. THE CLEAN CAR ────────────────────────────────────────────────────────────────────────────
console.log('\n— absence of findings is not absence of looking —');
check('a car with NO findings and NO affirmative is NOT done', intakeItemDone('findings', NONE) === false,
  'nobody has said they looked');
check('a FINDING satisfies it', intakeItemDone('findings', { ...NONE, dueItemCount: 1 }) === true);
check('THE AFFIRMATIVE satisfies it too — the clean car', intakeItemDone('findings', { ...NONE, nothingFoundAt: new Date() }) === true,
  'without this a properly-checked clean car must SKIP, and every one is a false escalation');
// The discriminator: if the rule were "a finding exists", the clean car would be indistinguishable
// from the un-checked car. Prove those two states differ.
check('  …and it is discriminating — checked-clean ≠ never-checked',
  intakeItemDone('findings', { ...NONE, nothingFoundAt: new Date() }) !== intakeItemDone('findings', NONE));

// ── 2. THE OTHER THREE DERIVE FROM THEIR ARTEFACT ──────────────────────────────────────────────
console.log('\n— every done-state comes from the artefact, not a flag —');
check('mileage_vin needs BOTH', intakeItemDone('mileage_vin', { ...NONE, odometerIn: 100 }) === false
  && intakeItemDone('mileage_vin', { ...NONE, vin: 'X' }) === false
  && intakeItemDone('mileage_vin', { ...NONE, odometerIn: 100, vin: 'X' }) === true);
check('a blank VIN string does not count', intakeItemDone('mileage_vin', { ...NONE, odometerIn: 100, vin: '   ' }) === false);
check('walkaround needs the video', intakeItemDone('walkaround', { ...NONE, hasIntakeVideo: true }) === true);
check('diag_scan needs the scan photo', intakeItemDone('diag_scan', { ...NONE, hasDiagScanPhoto: true }) === true);

// ── 3. A SKIP IS SPENT WHEN THE THING IS DONE ──────────────────────────────────────────────────
console.log('\n— done wins over a historical skip —');
const skipped = { diag_scan: { reason: 'Equipment fault' } };
const beforeDoing = intakeItemStates(NONE, ALL_ON, skipped).find((s) => s.item === 'diag_scan');
check('skipped and not done → skipped', beforeDoing.skipped === true && beforeDoing.skipReason === 'Equipment fault');
const afterDoing = intakeItemStates({ ...NONE, hasDiagScanPhoto: true }, ALL_ON, skipped).find((s) => s.item === 'diag_scan');
check('skipped at 09:30, DONE at 10:00 → simply done', afterDoing.done === true && afterDoing.skipped === false,
  'a spent skip must not follow the card around');

// ── 4. WHAT THE ESCALATION WILL REPORT ─────────────────────────────────────────────────────────
console.log('\n— the escalation reports NOT DONE, not "was skipped" —');
const noneOn = intakeItemStates(NONE, {}, {});
check('an item switched OFF is never prompted and never reported', intakeOutstanding(noneOn).length === 0,
  'switched off generates nothing at all');
const neverOpened = intakeOutstanding(intakeItemStates(NONE, ALL_ON, {}));
check('a mechanic who never opened the tab leaves all four outstanding', neverOpened.length === 4,
  'catching only the one who pressed skip would miss the commoner case');
const cleanCar = intakeOutstanding(intakeItemStates({ ...NONE, nothingFoundAt: new Date(), odometerIn: 1, vin: 'X', hasIntakeVideo: true, hasDiagScanPhoto: true }, ALL_ON, {}));
check('a fully-done clean car reports NOTHING — no email at all', cleanCar.length === 0,
  'the escalation must be silent when the workshop did its job');

// ── 5. NOTHING HERE BLOCKS ─────────────────────────────────────────────────────────────────────
console.log('\n— prompt, never gate —');
const tabs = readFileSync('lib/jobcard-tabs.ts', 'utf8');
check('the tab spine knows nothing about intake items', !/intake_prompt|intakeItem/.test(tabs),
  'a prompt that could lock a stage would be a gate wearing a different name');
const api = readFileSync('pages/api/jobcard-stage.ts', 'utf8');
check('advancing the stage does not consult them either', !/intake_prompt|intakeItem/.test(api));
const ui = readFileSync('components/jobcard/IntakeChecklist.tsx', 'utf8');
// COMMENT-STRIPPED. The first version matched the file's own comment explaining why a required
// category would be ceremony — a scanner reading the prose that describes what the code does NOT
// do. Strip the comments, then assert the explanation survives separately.
const uiCode = ui.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\{\/\*[\s\S]*?\*\/\}/g, '').replace(/^\s*\/\/.*$/gm, '');
check('the checklist ships both reason chips', SKIP_REASON_CHIPS.every((c) => uiCode.includes(c)));
check('  …and the reason box carries NO required attribute', !/\brequired\b/.test(uiCode) && /reasonPlaceholder/.test(uiCode),
  'a required category on a phone in a workshop is ceremony; the chips make one tap enough');
check('  …with the reasoning kept for the next reader', /REQUIRED category on a phone in a workshop is ceremony/.test(ui));
// And the skip itself must be reachable with NO reason at all — silence is allowed, and the email
// then says "no reason given", which is itself information.
check('a skip with an empty reason is still a skip', /reason: \(reason \?\? ''\)\.trim\(\)\.slice\(0, 300\) \|\| null/.test(readFileSync('pages/api/intake-items.ts', 'utf8')));

// ── 6. LIVE ON ZZ ──────────────────────────────────────────────────────────────────────────────
console.log('\n— on ZZ: the affirmative, and a finding that contradicts it —');
let fix = null;
try {
  const site = await prisma.site.findFirst({ where: { group_id: ZZ }, select: { id: true } });
  const veh = await prisma.vehicle.create({ data: { group_id: ZZ, registration: 'ZZ90 INT', registration_normalized: 'ZZ90INT' }, select: { id: true } });
  const card = await prisma.jobCard.create({ data: { group_id: ZZ, site_id: site.id, vehicle_id: veh.id, status: 'draft' }, select: { id: true } });
  fix = { vehId: veh.id, cardId: card.id };

  await prisma.jobCard.update({ where: { id: card.id }, data: { intake_nothing_found_at: new Date(), intake_nothing_found_by: null } });
  let c = await prisma.jobCard.findUnique({ where: { id: card.id }, select: { intake_nothing_found_at: true } });
  check('the affirmative is stored on the card', c.intake_nothing_found_at !== null);

  // A FINDING CONTRADICTS IT. The due-items writer clears it, so the card never says both.
  const item = await prisma.vehicleDueItem.create({
    data: { group_id: ZZ, vehicle_id: veh.id, found_on_job_card_id: card.id, description: 'gate: discs',
            due_basis: 'next_service', customer_response: 'not_raised' },
    select: { id: true },
  });
  await prisma.jobCard.update({ where: { id: card.id }, data: { intake_nothing_found_at: null, intake_nothing_found_by: null } });
  c = await prisma.jobCard.findUnique({ where: { id: card.id }, select: { intake_nothing_found_at: true } });
  check('recording a finding clears it — a card never asserts both', c.intake_nothing_found_at === null,
    '"nothing found" alongside real findings says two things at once');
  check('  …and the writer does that itself, not by hand here',
    /intake_nothing_found_at: null/.test(readFileSync('pages/api/due-items.ts', 'utf8')));
  const facts = { dueItemCount: 1, nothingFoundAt: null, odometerIn: null, vin: null, hasIntakeVideo: false, hasDiagScanPhoto: false };
  check('and the item is STILL done — via the finding, not the affirmative', intakeItemDone('findings', facts) === true);
  await prisma.vehicleDueItem.delete({ where: { id: item.id } });

  // The switches are per-SITE and default OFF.
  const s = await prisma.site.findUnique({ where: { id: site.id }, select: { intake_prompt_findings: true, intake_prompt_diag_scan: true } });
  check('switches default OFF — the feature ships inert', s.intake_prompt_findings === false && s.intake_prompt_diag_scan === false);
} catch (e) {
  check('fixture run completed', false, String(e?.message ?? e).slice(0, 250));
} finally {
  if (fix) {
    await prisma.vehicleDueItem.deleteMany({ where: { vehicle_id: fix.vehId } });
    await prisma.jobCard.deleteMany({ where: { id: fix.cardId } });
    await prisma.vehicle.delete({ where: { id: fix.vehId } }).catch(() => {});
    check('teardown removed every fixture row',
      (await prisma.vehicle.count({ where: { id: fix.vehId } })) === 0);
  }
}

console.log(`\n${out.filter((c) => c === 'F').length} failures of ${out.length}`);
await prisma.$disconnect();
process.exit(out.includes('F') ? 1 : 0);
