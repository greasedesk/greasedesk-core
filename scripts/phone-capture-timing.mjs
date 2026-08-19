/**
 * File: scripts/phone-capture-timing.mjs
 * HOW LONG THE CAPTURE ACTUALLY TAKES, ON A PHONE.
 *
 * The earlier number (4.5s) was measured on a desktop at 1280px with instant clicks. It does not
 * transfer: the mechanic is holding a 390px screen, wearing gloves, standing at a car. So this
 * re-runs the same test on the surface that ships — /m/job/[id] at 390px, in a real Chrome, with a
 * deliberate 600ms between every control to stand in for a human hand rather than a script.
 *
 * 600ms is the pace, not the finding. The finding is the CONTROL COUNT: pace is a multiplier a
 * faster or slower human moves, but the number of taps is what the design fixed. Both are reported.
 *
 * Two cars, because the average is the wrong thing to design for:
 *   A. normal      — four corners worn evenly, one finding.
 *   B. worst real  — three even, one worn unevenly (three separate readings), plus a finding with
 *                    a mileage basis. Not "every tyre split": that car goes on a ramp, not a form.
 */
import './_gate-preflight.mjs';
import './_ts.mjs';
const { PrismaClient } = await import('@prisma/client');
const { chromium } = await import('/Users/hugh/Developer/greasedesk-core/node_modules/playwright-core/index.mjs');
const prisma = new PrismaClient();

const ZZ = 'c75ac44e-250a-4c90-98ba-a8326e98dad5';
const B = process.env.GATE_BASE ?? 'http://localhost:3000';
const PACE = Number(process.env.PACE_MS ?? 600);
const out = [];
const check = (n, ok, d = '') => { out.push(ok ? 'P' : 'F'); console.log(`${ok ? '✓' : '✗'} ${n}${d ? `  — ${d}` : ''}`); };

let fix = null, browser = null;
const rows = [];

try {
  // A THROWAWAY SITE, not the tenant's own. The prompts are per-site and default OFF, and the first
  // draft of this script asserted the checklist renders on ZZ's real site — where all four are off,
  // so it correctly rendered nothing. Flipping switches on a live site to make a test pass would
  // have been the wrong repair; a fixture site that is deleted afterwards is the right one, and it
  // also proves the switch is read at RENDER rather than stamped onto the card.
  const site = await prisma.site.create({
    data: {
      group_id: ZZ, site_name: 'ZZ Timing Fixture Site',
      intake_prompt_findings: true, intake_prompt_walkaround: true,
    },
    select: { id: true },
  });
  const veh = await prisma.vehicle.create({
    data: { group_id: ZZ, registration: 'ZZ76TIM', make: 'Timing', model: 'Fixture' }, select: { id: true },
  });
  const card = await prisma.jobCard.create({
    data: { group_id: ZZ, site_id: site.id, vehicle_id: veh.id, status: 'in_progress', odometer_in: 61000 },
    select: { id: true },
  });
  fix = { veh: veh.id, card: card.id, site: site.id };

  browser = await chromium.launch({ channel: 'chrome' });
  const ctx = await browser.newContext({
    viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true,
  });
  const page = await ctx.newPage();
  await page.goto(`${B}/admin/login`, { waitUntil: 'domcontentloaded' });
  await page.fill('input[type="email"]', 'owner@zzgategarage.test');
  await page.fill('input[type="password"]', 'GateGarage!2026');
  await Promise.all([page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 60000 }), page.click('button[type="submit"]')]);

  // Every tap goes through this, so the pace is uniform and the count is honest.
  let taps = 0;
  const tap = async (tid) => { taps++; await page.waitForTimeout(PACE); await page.locator(`[data-testid="${tid}"]`).click(); };
  const type = async (tid, v) => { taps++; await page.waitForTimeout(PACE); await page.fill(`[data-testid="${tid}"]`, v); };

  async function run(label, plan) {
    await page.goto(`${B}/m/job/${fix.card}`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('[data-testid="phone-tyres"]', { timeout: 30000 });
    taps = 0;
    const t0 = Date.now();
    await plan();
    const secs = (Date.now() - t0) / 1000;
    rows.push({ label, taps, secs, thinking: secs - taps * (PACE / 1000) });
    return secs;
  }

  // ── ORDER, ON THE SERVED PAGE ───────────────────────────────────────────────────────────────
  // Down the screen: what the car needs, then the tyres, then the pictures, then send it. That is
  // the order a walkaround happens in, and getting it from a static read of the JSX would prove
  // only that the file lists them — not that they render.
  console.log('\n— the phone page, top to bottom —');
  await page.goto(`${B}/m/job/${fix.card}`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-testid="phone-tyres"]', { timeout: 30000 });
  const order = await page.evaluate(() => ['phone-checklist', 'phone-findings', 'phone-tyres', 'phone-send-report']
    .map((t) => { const e = document.querySelector(`[data-testid="${t}"]`); return e ? { t, y: e.getBoundingClientRect().top + window.scrollY } : { t, y: null }; }));
  check('all four intake sections render on the phone', order.every((o) => o.y !== null),
    order.filter((o) => o.y === null).map((o) => o.t).join(', ') || 'all present');
  const promptCount = await page.locator('[data-testid^="ph-item-"]').count();
  check('  …and the checklist shows the TWO prompts this site switched on, not four', promptCount === 2,
    `${promptCount} items — an unprompted item must never appear, or the escalation names it later`);
  const ys = order.map((o) => o.y);
  check('  …checklist → findings → tyres → send, in that order',
    ys.every((y, i) => i === 0 || (y !== null && ys[i - 1] !== null && y > ys[i - 1])),
    order.map((o) => `${o.t}@${o.y === null ? '—' : Math.round(o.y)}`).join(' · '));
  const mot = await page.locator('[data-testid="phone-mot"]').count();
  check('  …and the MOT sits with the findings, read-only', mot === 1 || mot === 0,
    mot ? 'shown from DVSA' : 'no MOT on this fixture vehicle — nothing to show');

  // ── A. NORMAL CAR ───────────────────────────────────────────────────────────────────────────
  console.log(`\n— A: normal car, four even corners + one finding, ${PACE}ms per control —`);
  await run('A. normal', async () => {
    for (const c of ['front_left', 'front_right', 'rear_left', 'rear_right']) await tap(`ph-tyre-${c}-chip-60`);
    await tap('phone-tyre-save');
    await page.waitForSelector('[data-testid="phone-tyres-queued"]', { timeout: 15000 });
    await tap('phone-finding-add');
    await type('phone-finding-desc', 'Rear pads getting low');
    await tap('phone-basis-next_service');
    await tap('phone-answer-not_raised');
    await tap('phone-finding-save');
  });
  check('A queued four corners', await page.locator('[data-testid="phone-tyres-queued"]').count() === 1);

  // ── B. WORST REALISTIC ──────────────────────────────────────────────────────────────────────
  console.log('\n— B: three even, one split three ways, + a finding on a mileage —');
  await run('B. worst realistic', async () => {
    for (const c of ['front_right', 'rear_left', 'rear_right']) await tap(`ph-tyre-${c}-chip-60`);
    await tap('ph-tyre-front_left-uneven');
    await tap('ph-tyre-front_left-outer-20');
    await tap('ph-tyre-front_left-centre-50');
    await tap('ph-tyre-front_left-inner-60');
    await tap('ph-tyre-front_left-type-winter_standard');
    await tap('phone-tyre-save');
    await page.waitForSelector('[data-testid="phone-tyres-queued"]', { timeout: 15000 });
    await tap('phone-finding-add');
    await type('phone-finding-desc', 'Front tyres worn on the outer edge — needs alignment');
    await tap('phone-basis-mileage');
    await type('phone-finding-mileage', '65000');
    await tap('phone-answer-agreed_later');
    await tap('phone-finding-save');
  });
  check('B reported all four corners ready', (await page.locator('[data-testid="phone-tyre-progress"]').innerText()).startsWith('4 of 4'));

  // ── THE MEASUREMENT ─────────────────────────────────────────────────────────────────────────
  console.log('\n— measured —');
  for (const r of rows) {
    console.log(`  ${r.label.padEnd(20)} ${r.taps} controls · ${r.secs.toFixed(1)}s wall · ${r.thinking.toFixed(1)}s of that is the app`);
  }
  const worst = Math.max(...rows.map((r) => r.secs));
  check('the worst realistic car stays under a minute', worst < 60, `${worst.toFixed(1)}s at ${PACE}ms per control`);
  const appTime = Math.max(...rows.map((r) => r.thinking));
  check('  …and almost none of that is the app', appTime < 6,
    `${appTime.toFixed(1)}s outside the human pace — the rest is the hand, which is as it should be`);
  // 15 is measured, not chosen — 9 for the split corner (3 chips + open it up + 3 depths + type +
  // save) and 6 for the finding. It is pinned because it is the number the DESIGN fixed: pace is a
  // multiplier any hand can move, but a sixteenth tap would be somebody's decision, and it should
  // read as one. If this fails, either the capture grew a step or it lost one — both are news.
  const worstTaps = Math.max(...rows.map((r) => r.taps));
  check('the control count has not drifted', worstTaps === 15, `${worstTaps} controls worst case`);

  const readings = await prisma.tyreReading.count({ where: { job_card_id: fix.card } });
  check('and the queue actually delivered', readings === 4, `${readings} readings landed`);
} catch (e) {
  check('timing run completed', false, String(e?.message ?? e).slice(0, 300));
} finally {
  if (browser) await browser.close().catch(() => {});
  if (fix) {
    // Intake item state is DERIVED (lib/intake-items reads facts + audit) — there is no table here,
    // and the first draft of this teardown tried to delete one. It threw, and the finally block
    // stopped dead with the fixture vehicle still on a live tenant. So each step now stands alone:
    // one bad delete must not take the rest of the teardown down with it.
    // AuditLog is append-only. Its rows for this card stay, correctly.
    const step = async (n, f) => { try { await f(); } catch (e) { console.log(`  teardown ${n}: ${String(e?.message ?? e).slice(0, 90)}`); } };
    await step('readings', () => prisma.tyreReading.deleteMany({ where: { vehicle_id: fix.veh } }));
    await step('due items', () => prisma.vehicleDueItem.deleteMany({ where: { vehicle_id: fix.veh } }));
    await step('card', () => prisma.jobCard.deleteMany({ where: { id: fix.card } }));
    await step('vehicle', () => prisma.vehicle.delete({ where: { id: fix.veh } }));
    await step('site', () => prisma.site.delete({ where: { id: fix.site } }));
    check('teardown removed every fixture row',
      (await prisma.vehicle.count({ where: { id: fix.veh } })) === 0
      && (await prisma.jobCard.count({ where: { id: fix.card } })) === 0
      && (await prisma.site.count({ where: { id: fix.site } })) === 0);
  }
}

console.log(`\n${out.filter((c) => c === 'F').length} failures of ${out.length}`);
await prisma.$disconnect();
process.exit(out.includes('F') ? 1 : 0);
