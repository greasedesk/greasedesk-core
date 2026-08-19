/**
 * File: scripts/oil-level-gate.mjs
 * THE DIPSTICK — five readings, and the two that record without advising.
 *
 * Oil level is deliberately NOT in the tap list. Every entry there is tapped only when it is TRUE;
 * this one is a prompt to LOOK, and "checked, it's fine" is a record no absence can express — the
 * same argument that made "nothing found" an artefact. So it is a checklist item, switchable per
 * site, and these assertions are mostly about the readings that say nothing.
 *
 * Fixtures on ZZ Gate Garage only. Never TMBS.
 */
import './_gate-preflight.mjs';
import './_ts.mjs';
const { PrismaClient } = await import('@prisma/client');
const O = await import('../lib/oil-level.ts');
const I = await import('../lib/intake-items.ts');
const C = await import('../lib/observations.ts');
const { readFileSync } = await import('node:fs');
const { chromium } = await import('/Users/hugh/Developer/greasedesk-core/node_modules/playwright-core/index.mjs');
const prisma = new PrismaClient();
const BASE = process.env.GATE_BASE ?? 'http://localhost:3000';

const ZZ = 'c75ac44e-250a-4c90-98ba-a8326e98dad5';
const out = [];
const check = (n, ok, d = '') => { out.push(ok ? 'P' : 'F'); console.log(`${ok ? '✓' : '✗'} ${n}${d ? `  — ${d}` : ''}`); };
const prose = (t) => t.replace(/^\s*\*\s?/gm, ' ').replace(/\s+/g, ' ');
/** The advisory TEXT, or a sentinel. A probe that removes a reading's rule returns null, and
 *  reading .description off it aborted the run — one failure reported, the rest skipped. A gate
 *  must fail loudly AND completely. Third time this shape has bitten; it is now the default here. */
const say = (level) => O.oilLevelAdvisory(level)?.description ?? '«no advisory raised»';

let fix = null, browser = null;

try {
  // ── 1. FIVE READINGS, THREE ADVISORIES ───────────────────────────────────────────────────────
  console.log('\n— what each reading says —');
  check('five readings', O.OIL_LEVELS.length === 5, O.OIL_LEVELS.join(', '));
  check('below min advises, urgently', O.oilLevelAdvisory('below_min')?.urgent === true);
  check('at min advises, not urgently', O.oilLevelAdvisory('at_min')?.urgent === false);
  check('between says NOTHING', O.oilLevelAdvisory('between') === null);
  check('at max says nothing either', O.oilLevelAdvisory('at_max') === null);
  check('OVER MAX advises — the one a yes/no question cannot see',
    O.oilLevelAdvisory('above_max') !== null,
    'overfilling aerates the oil and can push out seals; "is it low?" never asks');
  check('  …and it describes rather than diagnoses',
    /above the maximum mark/.test(say('above_max')) && !/overfill|garage|burning/i.test(say('above_max')),
    say('above_max'));
  check('every description follows the observation rule',
    O.OIL_LEVELS.map((l) => O.oilLevelAdvisory(l)).filter(Boolean)
      .every((a) => !/\b(worn|faulty|failed|needs? replacing|replace)\b/i.test(a.description)));

  // ── 2. IT IS A CHECKLIST ITEM, NOT A TAP-OBSERVATION ─────────────────────────────────────────
  console.log('\n— prompted per site, satisfied by any reading —');
  check('it is a fifth intake item', I.INTAKE_ITEMS.includes('oil_level'));
  check('  …with its own site switch', I.INTAKE_SWITCH.oil_level === 'intake_prompt_oil_level');
  check('  …and it is NOT in the tap catalogue', C.observationByKey('oil_level') === null,
    'the tap list means "tap it when it is true"; this one is always recorded');
  check('a HEALTHY reading satisfies the item',
    I.intakeItemDone('oil_level', { dueItemCount: 0, nothingFoundAt: null, odometerIn: null, vin: null, hasIntakeVideo: false, hasDiagScanPhoto: false, oilLevelAt: new Date() }) === true,
    'the item is "did you check", not "was there a problem"');
  check('  …and no reading at all leaves it undone',
    I.intakeItemDone('oil_level', { dueItemCount: 0, nothingFoundAt: null, odometerIn: null, vin: null, hasIntakeVideo: false, hasDiagScanPhoto: false, oilLevelAt: null }) === false);
  check('the reason it is not a table is written down',
    /consumption between\s*top-ups/i.test(prose(readFileSync('lib/oil-level.ts', 'utf8'))),
    'tyres and battery earned tables on trajectory; this has no series to draw');

  // ── 3. AGAINST THE DATABASE ──────────────────────────────────────────────────────────────────
  console.log('\n— on a throwaway car —');
  const site = await prisma.site.findFirst({ where: { group_id: ZZ }, select: { id: true } });
  const veh = await prisma.vehicle.create({ data: { group_id: ZZ, registration: 'ZZ76OIL', make: 'Oil', model: 'Fixture' }, select: { id: true } });
  const card = await prisma.jobCard.create({ data: { group_id: ZZ, site_id: site.id, vehicle_id: veh.id, status: 'draft' }, select: { id: true } });
  fix = { veh: veh.id, card: card.id };

  // The endpoint's behaviour, exercised through the same writer shape it uses.
  const record = async (level) => {
    const advisory = O.oilLevelAdvisory(level);
    await prisma.$transaction(async (tx) => {
      const open = await tx.vehicleDueItem.findFirst({
        where: { group_id: ZZ, vehicle_id: veh.id, closed_at: null, observation_key: O.OIL_LEVEL_KEY }, select: { id: true },
      });
      if (!advisory) {
        if (open) await tx.vehicleDueItem.update({ where: { id: open.id }, data: { closed_at: new Date(), closed_job_card_id: card.id, closed_reason: 'Re-checked and within range' } });
        return;
      }
      const data = { observation_key: O.OIL_LEVEL_KEY, description: advisory.description, due_basis: 'next_service', timing_in_description: false };
      if (open) await tx.vehicleDueItem.update({ where: { id: open.id }, data });
      else await tx.vehicleDueItem.create({ data: { group_id: ZZ, vehicle_id: veh.id, found_on_job_card_id: card.id, customer_response: 'not_raised', ...data } });
    });
  };

  await record('below_min');
  let items = await prisma.vehicleDueItem.findMany({ where: { vehicle_id: veh.id }, select: { description: true, observation_key: true, timing_in_description: true, closed_at: true } });
  check('a low level raises one finding', items.length === 1 && items[0].observation_key === 'oil_level', items[0]?.description);
  check('  …with the timing left to the basis', items[0]?.timing_in_description === false);

  // A CORRECTION, not a second finding.
  await record('at_min');
  items = await prisma.vehicleDueItem.findMany({ where: { vehicle_id: veh.id, closed_at: null }, select: { description: true } });
  check('correcting the reading corrects the finding', items.length === 1 && /at the minimum mark/.test(items[0].description), items[0]?.description);

  // TOPPED UP ON THE SPOT — the warning must not survive it.
  await record('between');
  const open = await prisma.vehicleDueItem.count({ where: { vehicle_id: veh.id, closed_at: null } });
  const closed = await prisma.vehicleDueItem.findFirst({ where: { vehicle_id: veh.id, closed_at: { not: null } }, select: { closed_reason: true } });
  check('a healthy re-check CLOSES the warning', open === 0 && closed?.closed_reason === 'Re-checked and within range',
    'leaving it open would put a finding on the invoice for something no longer true');

  await record('above_max');
  const over = await prisma.vehicleDueItem.findFirst({ where: { vehicle_id: veh.id, closed_at: null }, select: { description: true } });
  check('and over-max raises its own', /above the maximum mark/.test(over?.description ?? ''), over?.description);

  // ── AND IT ACTUALLY REACHES THE CARD ─────────────────────────────────────────────────────────
  // The point of the derivation fix. Before it, switching this on did nothing at all: the column
  // was never selected, so the item could not be prompted even from the database. Proven on the
  // SERVED page, because that is where it was invisible.
  console.log('\n— switched on, it appears —');
  const fixSite = await prisma.site.create({
    data: { group_id: ZZ, site_name: 'ZZ Oil Prompt Site', intake_prompt_oil_level: true },
    select: { id: true },
  });
  fix.site = fixSite.id;
  const pCard = await prisma.jobCard.create({
    data: { group_id: ZZ, site_id: fixSite.id, vehicle_id: veh.id, status: 'in_progress', stage_details_done: true },
    select: { id: true },
  });
  fix.pCard = pCard.id;

  browser = await chromium.launch({ channel: 'chrome' });
  const page = await (await browser.newContext()).newPage();
  await page.goto(`${BASE}/admin/login`, { waitUntil: 'domcontentloaded' });
  await page.fill('input[type="email"]', 'owner@zzgategarage.test');
  await page.fill('input[type="password"]', 'GateGarage!2026');
  await Promise.all([page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 60000 }), page.click('button[type="submit"]')]);
  await page.goto(`${BASE}/admin/jobcards/${pCard.id}`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: 'Intake', exact: false }).first().click();
  await page.waitForSelector('[data-testid="oil-level-chips"]', { timeout: 25000 });
  check('the dipstick chips render on the served card', true);
  check('  …all five of them',
    (await page.locator('[data-testid^="oil-level-"]').count()) === O.OIL_LEVELS.length + 1,
    'five chips plus their container');
  check('  …and only the switched-on prompt appears',
    (await page.locator('[data-testid="intake-checklist"] li').count()) === 1,
    'the other four are off for this site, and an unprompted item must never show');
} catch (e) {
  check('gate run completed', false, String(e?.message ?? e).slice(0, 300));
} finally {
  if (browser) await browser.close().catch(() => {});
  if (fix) {
    const step = async (n, f) => { try { await f(); } catch (e) { console.log(`  teardown ${n}: ${String(e?.message ?? e).slice(0, 90)}`); } };
    // AuditLog is append-only. Its rows for this card stay, correctly.
    await step('due items', () => prisma.vehicleDueItem.deleteMany({ where: { vehicle_id: fix.veh } }));
    await step('cards', () => prisma.jobCard.deleteMany({ where: { id: { in: [fix.card, fix.pCard].filter(Boolean) } } }));
    await step('vehicle', () => prisma.vehicle.delete({ where: { id: fix.veh } }));
    await step('site', () => (fix.site ? prisma.site.delete({ where: { id: fix.site } }) : Promise.resolve()));
    // ZZ-SCOPED: a global count reports another garage's work as ours.
    check('teardown removed every fixture row (ZZ only)',
      (await prisma.vehicle.count({ where: { group_id: ZZ, id: fix.veh } })) === 0
      && (await prisma.vehicleDueItem.count({ where: { group_id: ZZ, vehicle_id: fix.veh } })) === 0
      && (await prisma.site.count({ where: { group_id: ZZ, site_name: { contains: 'Oil Prompt' } } })) === 0);
  }
}

// ── 4. THE RETIRED ENTRIES ──────────────────────────────────────────────────────────────────────
console.log('\n— retired, not deleted —');
const retired = C.OBSERVATIONS.filter((o) => o.retired);
check('five entries are retired', retired.length === 5, retired.map((o) => o.key).join(', '));
check('  …and none of them is offered', C.TOP_LEVEL.every((o) => !o.retired));
check('  …but every one is still nameable',
  retired.every((o) => C.observationByKey(o.key)?.description),
  'a key with no catalogue entry cannot be named in a count');
check('twelve remain on the top level', C.TOP_LEVEL.length === 12, C.TOP_LEVEL.map((o) => o.key).join(', '));
check('the reason retirement exists is written down',
  /cannot be named in a count/.test(prose(readFileSync('lib/observations.ts', 'utf8'))));

// ── 5. THE SWITCH IS REACHABLE — THE CLASS, NOT THE INSTANCE ────────────────────────────────────
// oil_level shipped with a switch, an endpoint, chips and a gate, and was UNREACHABLE: five files
// wrote the four column names out by hand, so the fifth was never selected, read as `undefined`,
// and could never be prompted. INTAKE_SWITCH is a total Record and protected exactly one file.
console.log('\n— a sixth prompt would reach every surface —');
check('the Prisma select is derived from the switch map',
  Object.keys(I.INTAKE_PROMPT_SELECT).length === I.INTAKE_ITEMS.length
  && I.INTAKE_ITEMS.every((it) => I.INTAKE_PROMPT_SELECT[I.INTAKE_SWITCH[it]] === true),
  Object.keys(I.INTAKE_PROMPT_SELECT).join(', '));
check('  …including the newest one', I.INTAKE_PROMPT_SELECT.intake_prompt_oil_level === true,
  'this is the exact key that was missing');
check('a missing column reads FALSE, never true', promptFalse(),
  'an unloaded switch must mean "not prompted" — the opposite would put an unasked item in the escalation');
function promptFalse() {
  const sw = I.promptSwitches({ intake_prompt_findings: true });
  return sw.intake_prompt_findings === true && sw.intake_prompt_oil_level === false;
}

// NO FILE OUTSIDE lib/intake-items MAY NAME A PROMPT COLUMN. That is the class.
const FILES = [
  'lib/jobcard-page-data.ts', 'pages/api/locations.ts', 'pages/admin/settings/locations.tsx',
];
const offenders = FILES.filter((f) => /intake_prompt_[a-z_]+/.test(
  readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')));
check('no surface names a prompt column literally any more', offenders.length === 0,
  offenders.join(', ') || 'the three that did, now derived');
check('  …and the scanner would catch one if it came back',
  /intake_prompt_[a-z_]+/.test('site: { select: { intake_prompt_findings: true } }'),
  'a pattern that matches nothing proves nothing');

console.log(`\n${out.filter((c) => c === 'F').length} failures of ${out.length}`);
await prisma.$disconnect();
process.exit(out.includes('F') ? 1 : 0);
