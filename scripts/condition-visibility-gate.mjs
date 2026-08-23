/**
 * File: scripts/condition-visibility-gate.mjs
 * THE CARD AND THE REPORT AGREE — asserted against EACH OTHER, not each against a fixture.
 *
 * ── THE DEFECT THIS EXISTS FOR ──────────────────────────────────────────────────────────────────
 * Tyre and battery readings had three readers — the customer report, the invoice freeze, and the
 * internal wear rate. The JOB CARD was not among them: both capture forms initialised blank and
 * were never told what the car already said.
 *
 * On a real MINI that produced the worst version of it. Four corners at 4.0mm and a battery at 76%
 * health; both healthy, so neither raised a finding; and findings were the only intake data the
 * card could render. The customer's report showed both, the card showed nothing, and the mechanic's
 * reasonable conclusion is that the save failed. A WORN tyre would at least have appeared as an
 * advisory — it is the reassuring reading that vanishes.
 *
 * ── WHY THE ASSERTION IS SHAPED THIS WAY ────────────────────────────────────────────────────────
 * Two gates, each checking one surface against expected values, would BOTH have passed before this
 * fix if the card's expectations had been written to match what the card did. The requirement is
 * not "the card shows 4.0mm", it is "the card and the report do not disagree" — so the two served
 * surfaces are read and compared to one another. A fixture is only used to create something to
 * disagree about.
 *
 * Fixtures on ZZ Gate Garage only. Never TMBS.
 */
import './_gate-preflight.mjs';
const { explainIfClientStale, zzSite, serverReady } = await import('./_gate-preflight.mjs');
import './_ts.mjs';
const { PrismaClient } = await import('@prisma/client');
const { chromium } = await import('/Users/hugh/Developer/greasedesk-core/node_modules/playwright-core/index.mjs');
const T = await import('../lib/tyres.ts');
const B = await import('../lib/battery.ts');
const prisma = new PrismaClient();

const ZZ = 'c75ac44e-250a-4c90-98ba-a8326e98dad5';
const BASE = process.env.GATE_BASE ?? 'http://localhost:3000';
const out = [];
const check = (n, ok, d = '') => { out.push(ok ? 'P' : 'F'); console.log(`${ok ? '✓' : '✗'} ${n}${d ? `  — ${d}` : ''}`); };
const D = (o, c, i) => ({ outer: o, centre: c, inner: i });

let fix = null, browser = null;

try {
  const site = await zzSite(prisma);
  const veh = await prisma.vehicle.create({ data: { group_id: ZZ, registration: 'ZZ76VIS', make: 'Visible', model: 'Fixture' }, select: { id: true } });
  const card = await prisma.jobCard.create({
    data: { group_id: ZZ, site_id: site.id, vehicle_id: veh.id, status: 'in_progress', stage_details_done: true, odometer_in: 50000 },
    select: { id: true },
  });
  fix = { veh: veh.id, card: card.id };

  // ── THE READINGS ARE DELIBERATELY HEALTHY ────────────────────────────────────────────────────
  // 4.0mm even, and a battery at 76% health with 90% charge. Both are ABOVE their advisory
  // thresholds, so neither raises a finding — which is the exact case that was invisible. A worn
  // tyre would have shown up as a due item and hidden the bug.
  await prisma.$transaction((tx) => T.recordTyreReadings(tx, {
    groupId: ZZ, vehicleId: veh.id, jobCardId: card.id, measuredBy: null, odometer: 50000,
    corners: ['front_left', 'front_right', 'rear_left', 'rear_right'].map((c) => ({ corner: c, type: 'summer_standard', depths: D(40, 40, 40) })),
  }));
  await prisma.$transaction((tx) => B.recordBatteryReading(tx, {
    groupId: ZZ, vehicleId: veh.id, jobCardId: card.id, measuredBy: null,
    reading: { voltageMv: 12570, socPct: 90, sohPct: 76, ratedCca: 760, ccaStandard: 'EN' },
  }));
  const raised = await prisma.vehicleDueItem.count({ where: { vehicle_id: veh.id } });
  check('a healthy car raises NO finding at all', raised === 0,
    'which is why the card could show nothing and look correct');

  // The dev server disposes inactive pages and serves 404s while it rebuilds one; a gate that
  // drives a page that was never served dies as a bare selector timeout 25s later. Warm it and
  // say so — see serverReady in _gate-preflight.
  const ready = await serverReady();
  check('the dev server serves pages before we drive it', ready.ok, `HTTP ${ready.status} after ${ready.attempts} attempt(s)`);
  browser = await chromium.launch({ channel: 'chrome' });
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto(`${BASE}/admin/login`, { waitUntil: 'domcontentloaded' });
  await page.fill('input[type="email"]', 'owner@zzgategarage.test');
  await page.fill('input[type="password"]', 'GateGarage!2026');
  await Promise.all([page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 60000 }), page.click('button[type="submit"]')]);

  // ── SURFACE ONE: THE JOB CARD ────────────────────────────────────────────────────────────────
  console.log('\n— what the garage sees —');
  await page.goto(`${BASE}/admin/jobcards/${card.id}`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: 'Intake', exact: false }).first().click();
  await page.waitForSelector('[data-testid="tyre-capture"]', { timeout: 25000 });

  const cardTyres = await page.evaluate(() =>
    [...document.querySelectorAll('[data-testid^="tyre-summary-"]')]
      .filter((e) => e.getAttribute('data-testid') !== 'tyre-summary-none')
      .map((e) => ({
        corner: e.getAttribute('data-testid').replace('tyre-summary-', ''),
        text: e.textContent.replace(/\s+/g, ' ').trim(),
      })));
  check('the card shows a tyre reading at all', cardTyres.length === 4,
    `${cardTyres.length} corners — this was ZERO before the fix`);
  const cardBattery = await page.locator('[data-testid="battery-summary"]').count()
    ? {
        soh: (await page.locator('[data-testid="battery-summary-soh"]').innerText()).trim(),
        soc: (await page.locator('[data-testid="battery-summary-soc"]').innerText()).trim(),
        volts: (await page.locator('[data-testid="battery-summary-voltage"]').innerText()).trim(),
      }
    : null;
  check('the card shows the battery test at all', cardBattery !== null, JSON.stringify(cardBattery));

  // ── SURFACE TWO: THE CUSTOMER'S REPORT ───────────────────────────────────────────────────────
  console.log('\n— what the customer sees —');
  const { createMagicLink } = await import('../lib/magic-link.ts');
  const link = await createMagicLink({ groupId: ZZ, jobCardId: card.id, purpose: 'intake_report', recipient: 'gate@example.invalid' });
  const cust = await (await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })).newPage();
  await cust.goto(`${BASE}/c/${link.rawToken}`, { waitUntil: 'domcontentloaded' });
  await cust.waitForSelector('[data-testid="report-tyres"]', { timeout: 30000 });

  const repTyres = await cust.evaluate(() =>
    [...document.querySelectorAll('[data-testid^="report-tyre-"]')].map((e) => ({
      corner: e.getAttribute('data-testid').replace('report-tyre-', ''),
      text: e.textContent.replace(/\s+/g, ' ').trim(),
    })));
  const repBattery = await cust.locator('[data-testid="report-battery"]').count()
    ? (await cust.locator('[data-testid="report-battery"]').innerText()).replace(/\s+/g, ' ')
    : null;
  check('the report shows the tyres', repTyres.length === 4, `${repTyres.length} corners`);
  check('the report shows the battery', repBattery !== null);

  // ── THE ACTUAL REQUIREMENT: THEY AGREE ───────────────────────────────────────────────────────
  // Compared surface-to-surface. Numbers are extracted from the rendered text of each rather than
  // from the database, because a shared query proves nothing if one page then renders it wrong.
  console.log('\n— and they do not disagree —');
  // NAMED VALUES, not every number on the tile. Scraping all decimals compared the card's three
  // against the report's four (it repeats the lowest in its own sentence) and reported a
  // disagreement where there was none — a fragile extraction pretending to be a finding. Both
  // surfaces render a headline "N.Nmm" and a "a / b / c" triple; those are what must match.
  const readTyre = (t) => {
    const lowest = t.match(/(\d+\.\d)mm/)?.[1] ?? '?';
    const triple = t.match(/(\d+\.\d) \/ (\d+\.\d) \/ (\d+\.\d)/);
    return `${lowest}mm [${triple ? triple.slice(1, 4).join('/') : '?'}]`;
  };
  const byCorner = (rows) => Object.fromEntries(rows.map((r) => [r.corner, readTyre(r.text)]));
  const cardMap = byCorner(cardTyres), repMap = byCorner(repTyres);
  check('the same four corners appear on both',
    JSON.stringify(Object.keys(cardMap).sort()) === JSON.stringify(Object.keys(repMap).sort()),
    `card ${Object.keys(cardMap).sort().join(',')} vs report ${Object.keys(repMap).sort().join(',')}`);
  for (const c of Object.keys(repMap)) {
    check(`  ${c} reads the same on both`, cardMap[c] === repMap[c], `card "${cardMap[c]}" vs report "${repMap[c]}"`);
  }
  check('the battery health agrees', repBattery?.includes('76') && cardBattery?.soh.includes('76'),
    `card "${cardBattery?.soh}" vs report containing 76`);
  check('  …and so do the charge and the voltage',
    repBattery?.includes('90') && cardBattery?.soc.includes('90')
    && repBattery?.includes('12.57') && cardBattery?.volts.includes('12.57'),
    `card ${cardBattery?.soc} / ${cardBattery?.volts}`);

  // ── ONE READER, SO AGREEMENT IS STRUCTURAL ───────────────────────────────────────────────────
  console.log('\n— agreement by construction, not by coincidence —');
  const { readFileSync } = await import('node:fs');
  const rep = readFileSync('lib/intake-report.ts', 'utf8');
  const cardData = readFileSync('lib/jobcard-page-data.ts', 'utf8');
  check('both surfaces call the shared reader',
    /latestTyres\(/.test(rep) && /latestBattery\(/.test(rep)
    && /latestTyres\(/.test(cardData) && /latestBattery\(/.test(cardData));
  // THE PRECISE TEST, TWICE CORRECTED. The first version banned batteryReading.findFirst outright
  // and failed on a query legitimately there for another job — jobcard-page-data fetches rated_cca
  // to PREFILL the form, which is not a condition. So it banned the raw COLUMNS instead. That was
  // still the wrong axis, and it failed again on 2026-08-20 when the tyre form began seeding
  // itself from this visit's depths: reading a depth to put it back in the box a mechanic typed it
  // into is the same kind of prefill as rated_cca, and no more a judgement of the tyre.
  //
  // What must not be duplicated is the DERIVATION — the thresholds, the band, the lowest-of-three,
  // the shoulder spread. Those live in lib/vehicle-condition and lib/tyres, and a second copy is
  // what "two derivations of one truth" means. So the ban is on the vocabulary of judgement, and
  // the raw columns are allowed where a form has to be filled.
  const judges = (src) => /LEGAL_MIN_TENTHS|ADVISE_BELOW_TENTHS|shoulderSpread|minDepth\(|band:\s*'|unevenEdge:/.test(src);
  check('  …and neither derives its own condition',
    !judges(rep) && !judges(cardData),
    'two derivations of one truth agree until somebody edits one of them');
  check('  …while a prefill query is still allowed to exist',
    /rated_cca: true/.test(cardData) && !judges(cardData),
    'fetching the rating to prefill a field is a different job from judging the battery');
  check('  …including the tyre form’s seed, which is the same kind of prefill',
    /depth_outer_tenths: true/.test(cardData) && !judges(cardData),
    'a depth put back into the box it was typed into is not a verdict about the tyre');
  // AND THE REPORT STILL HOLDS NO RAW DEPTHS AT ALL. It renders a condition and never builds one,
  // so for that file the stricter column ban is still the right test.
  check('  …and the customer report reads no raw depth or health column',
    !/depth_outer_tenths|depth_centre_tenths|soh_pct|soc_pct|voltage_mv/.test(rep),
    'the report has no form to fill, so it has no business holding the columns');

  // ── AND "NOTHING RECORDED" IS SAID, NOT LEFT BLANK ───────────────────────────────────────────
  console.log('\n— an untested car says so —');
  const veh2 = await prisma.vehicle.create({ data: { group_id: ZZ, registration: 'ZZ76VIS2', make: 'Untested', model: 'Fixture' }, select: { id: true } });
  const card2 = await prisma.jobCard.create({
    data: { group_id: ZZ, site_id: site.id, vehicle_id: veh2.id, status: 'in_progress', stage_details_done: true },
    select: { id: true },
  });
  fix.veh2 = veh2.id; fix.card2 = card2.id;
  await page.goto(`${BASE}/admin/jobcards/${card2.id}`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: 'Intake', exact: false }).first().click();
  await page.waitForSelector('[data-testid="tyre-capture"]', { timeout: 25000 });
  check('an untested car says so rather than showing an empty grid',
    (await page.locator('[data-testid="tyre-summary-none"]').count()) === 1
    && (await page.locator('[data-testid="battery-summary-none"]').count()) === 1,
    'a blank space is the thing this whole slice exists to stop');
} catch (e) {
  check('gate run completed', false, String(e?.message ?? e).slice(0, 300));
  await explainIfClientStale(BASE);
} finally {
  if (browser) await browser.close().catch(() => {});
  if (fix) {
    const step = async (n, f) => { try { await f(); } catch (e) { console.log(`  teardown ${n}: ${String(e?.message ?? e).slice(0, 90)}`); } };
    const vehIds = [fix.veh, fix.veh2].filter(Boolean);
    const cardIds = [fix.card, fix.card2].filter(Boolean);
    await step('links', () => prisma.customerMagicLink.deleteMany({ where: { job_card_id: { in: cardIds } } }));
    await step('tyres', () => prisma.tyreReading.deleteMany({ where: { vehicle_id: { in: vehIds } } }));
    await step('battery', () => prisma.batteryReading.deleteMany({ where: { vehicle_id: { in: vehIds } } }));
    await step('due items', () => prisma.vehicleDueItem.deleteMany({ where: { vehicle_id: { in: vehIds } } }));
    await step('cards', () => prisma.jobCard.deleteMany({ where: { id: { in: cardIds } } }));
    await step('vehicles', () => prisma.vehicle.deleteMany({ where: { id: { in: vehIds } } }));
    // ZZ-SCOPED, per the rule's other half: a global count reports another garage's work as ours.
    check('teardown removed every fixture row (ZZ only)',
      (await prisma.vehicle.count({ where: { group_id: ZZ, id: { in: vehIds } } })) === 0
      && (await prisma.tyreReading.count({ where: { group_id: ZZ, vehicle_id: { in: vehIds } } })) === 0
      && (await prisma.batteryReading.count({ where: { group_id: ZZ, vehicle_id: { in: vehIds } } })) === 0);
  }
}

console.log(`\n${out.filter((c) => c === 'F').length} failures of ${out.length}`);
await prisma.$disconnect();
process.exit(out.includes('F') ? 1 : 0);
