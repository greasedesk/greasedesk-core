// @gate-timeout: 180
/**
 * File: scripts/diag-scan-gate.mjs
 * AN ITEM NOBODY COULD EVER COMPLETE.
 *
 * `diag_scan` shipped with a switch, a label, a skip flow and a line in the escalation email — and
 * no writer. Its done-rule asked for a JobCardPhoto with slot 'diag_scan'; nothing in the codebase
 * ever wrote that slot, on any surface. Across every tenant: 0 rows. On a site with the prompt on,
 * the item could only ever be skipped, and the manager's escalation named it on every single card.
 * A manager who receives the same unsatisfiable line every day stops reading the email — which is
 * exactly the outcome lib/intake-items argues the prompt design exists to prevent.
 *
 * ── A CONFIRMATION, NOT A CAPTURE ───────────────────────────────────────────────────────────────
 * The scan runs on an external tool and its report is emailed elsewhere. There is no artefact for
 * us to hold, so asking for one was the mistake. The tick records a TIMESTAMP AND AN AUTHOR on the
 * card — the shape intake_nothing_found_at/_by already uses — and is undoable, because a mis-tap
 * must not be permanent. The audit keeps both events; only the current state changes.
 *
 * Fixtures on ZZ Gate Garage only. Never TMBS.
 */
import './_gate-preflight.mjs';
const { zzSite, serverReady } = await import('./_gate-preflight.mjs');
import './_ts.mjs';
const { PrismaClient } = await import('@prisma/client');
const { chromium } = await import('playwright-core');
const { readFileSync } = await import('node:fs');
const prisma = new PrismaClient();
const I = await import('../lib/intake-items.ts');
const E = await import('../lib/intake-escalation.ts');

const ZZ = 'c75ac44e-250a-4c90-98ba-a8326e98dad5';
const BASE = process.env.GATE_BASE ?? 'http://localhost:3000';
const REG = 'ZZ76DSC';
const out = [];
const check = (n, ok, d = '') => { out.push(ok ? 'P' : 'F'); console.log(`${ok ? '✓' : '✗'} ${n}${d ? `  — ${d}` : ''}`); };
let fix = null, browser = null;

const facts = (over = {}) => ({
  dueItemCount: 1, nothingFoundAt: null, odometerIn: 60_000, vin: 'WBAXXXXXXXXXXXXX',
  hasIntakeVideo: true, oilLevelAt: new Date(), diagScanAt: null, ...over,
});
const ON = { intake_prompt_findings: true, intake_prompt_mileage_vin: true, intake_prompt_walkaround: true,
  intake_prompt_diag_scan: true, intake_prompt_oil_level: true };

try {
  // ── 1. THE RULE ──────────────────────────────────────────────────────────────────────────────
  check('a ticked scan is done', I.intakeItemDone('diag_scan', facts({ diagScanAt: new Date() })) === true);
  check('  …and an unticked one is not', I.intakeItemDone('diag_scan', facts()) === false,
    'the discriminating half: a rule that always returned true would satisfy the item without anyone looking');
  // COMMENTS STRIPPED FIRST. The file now EXPLAINS that the fact used to be hasDiagScanPhoto, so a
  // bare scan matches its own explanation and reports correct code as broken — the fourth time this
  // exact shape has bitten. Strip prose, then look for the field.
  const prose = (f) => readFileSync(f, 'utf8').split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
  check('  …and it no longer asks for a photo slot', !/hasDiagScanPhoto/.test(prose('lib/intake-items.ts')),
    'nothing ever wrote slot diag_scan — 0 rows across every tenant');

  // ── 2. THE ESCALATION, BOTH WAYS ─────────────────────────────────────────────────────────────
  const lines = (f, sw) => E.outstandingLines(I.intakeOutstanding(I.intakeItemStates(f, sw, {})));
  const promptedNotDone = lines(facts(), ON);
  check('prompted and not done reaches the email', promptedNotDone.some((l) => /Diagnostic scan/i.test(l)),
    JSON.stringify(promptedNotDone));
  check('  …and ticking removes it', !lines(facts({ diagScanAt: new Date() }), ON).some((l) => /Diagnostic scan/i.test(l)),
    JSON.stringify(lines(facts({ diagScanAt: new Date() }), ON)));
  // THE OTHER DISCRIMINATOR: an item switched OFF is not prompted and must never be escalated —
  // otherwise every garage that does not own a scanner gets a daily email about not owning one.
  check('  …and a site with the prompt OFF never sees it',
    !lines(facts(), { ...ON, intake_prompt_diag_scan: false }).some((l) => /Diagnostic scan/i.test(l)),
    JSON.stringify(lines(facts(), { ...ON, intake_prompt_diag_scan: false })));

  // ── 3. DEAD CONSTANT ─────────────────────────────────────────────────────────────────────────
  const src = readFileSync('lib/intake-items.ts', 'utf8');
  check('DIAG_SCAN_SLOT is gone', !/export const DIAG_SCAN_SLOT/.test(src),
    'a constant nothing writes and nothing should read is a signpost to a path that does not exist');
  for (const f of ['lib/jobcard-page-data.ts', 'pages/api/jobcard-stage.ts']) {
    check(`  …and ${f.split('/').pop()} no longer imports it`, !/DIAG_SCAN_SLOT/.test(readFileSync(f, 'utf8')));
  }

  // ── 4. ON BOTH SURFACES, THROUGH THE SERVED PAGES ────────────────────────────────────────────
  const site = await zzSite(prisma);
  const ready = await serverReady();
  check('the dev server serves pages before we drive it', ready.ok, `HTTP ${ready.status}`);
  const stale = await prisma.vehicle.count({ where: { group_id: ZZ, registration: REG } });
  if (stale) throw new Error(`REFUSING: ${stale} fixture(s) from a previous run`);
  await prisma.site.update({ where: { id: site.id }, data: { intake_prompt_diag_scan: true } });
  const veh = await prisma.vehicle.create({ data: { group_id: ZZ, registration: REG, registration_normalized: REG, make: 'Diag', model: 'Fixture' }, select: { id: true } });
  const card = await prisma.jobCard.create({ data: { group_id: ZZ, site_id: site.id, vehicle_id: veh.id, status: 'in_progress', stage_details_done: true, odometer_in: 60_000 }, select: { id: true } });
  fix = { veh: veh.id, card: card.id, site: site.id };

  browser = await chromium.launch({ channel: 'chrome' });
  const page = await (await browser.newContext()).newPage();
  await page.goto(`${BASE}/admin/login`, { waitUntil: 'domcontentloaded' });
  await page.fill('input[type="email"]', 'owner@zzgategarage.test');
  await page.fill('input[type="password"]', 'GateGarage!2026');
  await Promise.all([page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 60000 }), page.click('button[type="submit"]')]);

  console.log('\n— the desktop checklist —');
  await page.goto(`${BASE}/admin/jobcards/${card.id}?tab=intake`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-testid="intake-checklist"]', { timeout: 25000 });
  const deskTick = page.locator('[data-testid="intake-diag-scan-done"]');
  check('the desktop offers a tick', await deskTick.count() === 1,
    'the only control it had was Skip');
  await deskTick.click();
  await page.waitForTimeout(2000);
  const after = await prisma.jobCard.findUnique({ where: { id: card.id }, select: { diag_scan_at: true, diag_scan_by: true } });
  check('  …and it records a time AND an author', after?.diag_scan_at != null && after?.diag_scan_by != null,
    JSON.stringify(after));
  check('  …audited as its own event', (await prisma.auditLog.count({ where: { group_id: ZZ, entity_id: card.id, action: 'intake.diag_scan' } })) === 1);

  console.log('\n— undo, for the mis-tap —');
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-testid="intake-checklist"]', { timeout: 25000 });
  const undo = page.locator('[data-testid="intake-undo-diag-scan"]');
  check('a ticked scan can be untucked', await undo.count() === 1, 'a mis-tap must not be permanent');
  await undo.click();
  await page.waitForTimeout(2000);
  const cleared = await prisma.jobCard.findUnique({ where: { id: card.id }, select: { diag_scan_at: true, diag_scan_by: true } });
  check('  …and the card forgets it', cleared?.diag_scan_at === null && cleared?.diag_scan_by === null, JSON.stringify(cleared));
  check('  …while the audit keeps BOTH events',
    (await prisma.auditLog.count({ where: { group_id: ZZ, entity_id: card.id, action: { in: ['intake.diag_scan', 'intake.diag_scan_cleared'] } } })) === 2,
    'AuditLog is append-only: the tick happened, and so did the correction');

  console.log('\n— the phone —');
  await page.goto(`${BASE}/m/job/${card.id}`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-testid="phone-checklist"]', { timeout: 25000 });
  const phoneTick = page.locator('[data-testid="intake-diag-scan-done"]');
  check('the phone offers the same tick', await phoneTick.count() === 1,
    'the scan is run at the car, so the phone is where it will be confirmed');
  await phoneTick.click();
  await page.waitForTimeout(2000);
  check('  …and it writes the same fact',
    (await prisma.jobCard.findUnique({ where: { id: card.id }, select: { diag_scan_at: true } }))?.diag_scan_at != null);
} catch (e) {
  console.log(`\n✗ THREW: ${String(e?.stack ?? e).slice(0, 800)}`);
  out.push('F');
} finally {
  if (browser) await browser.close().catch(() => {});
  if (fix) {
    const step = async (n, f) => { try { await f(); } catch (e) { console.log(`  teardown ${n}: ${String(e?.message ?? e).slice(0, 110)}`); } };
    // The site switch is ZZ's own setting and the fixture turned it on — put it back.
    await step('site switch', () => prisma.site.update({ where: { id: fix.site }, data: { intake_prompt_diag_scan: false } }));
    await step('card', () => prisma.jobCard.deleteMany({ where: { id: fix.card } }));
    await step('vehicle', () => prisma.vehicle.deleteMany({ where: { id: fix.veh } }));
    try {
      check('teardown removed every fixture row (ZZ only)',
        (await prisma.vehicle.count({ where: { id: fix.veh } })) === 0, 'AuditLog rows stay, append-only');
    } catch (e) { check('teardown removed every fixture row (ZZ only)', false, String(e?.message ?? e).slice(0, 70)); }
  }
  const f = out.filter((x) => x === 'F').length;
  console.log(`\n${f} failures of ${out.length}`);
  await prisma.$disconnect();
  process.exit(f ? 1 : 0);
}
