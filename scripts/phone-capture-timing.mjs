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
const { explainIfClientStale, serverReady } = await import('./_gate-preflight.mjs');
import './_ts.mjs';
const { PrismaClient } = await import('@prisma/client');
const { chromium } = await import('/Users/hugh/Developer/greasedesk-core/node_modules/playwright-core/index.mjs');
const { readFileSync } = await import('node:fs');
const prisma = new PrismaClient();

const ZZ = 'c75ac44e-250a-4c90-98ba-a8326e98dad5';
const B = process.env.GATE_BASE ?? 'http://localhost:3000';
const PACE = Number(process.env.PACE_MS ?? 600);
/** Per keystroke on a phone keyboard. ~3 characters a second, which is a realistic thumb. */
const KEY_MS = Number(process.env.KEY_MS ?? 330);
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
      // oil_level ON as well, because the panel that exposed the photo-only refresh is the oil
      // chip row — it is the only capture here that writes ONLINE with no "saved" message of its
      // own, so a screen that does not update is the entire feedback a mechanic gets.
      intake_prompt_findings: true, intake_prompt_walkaround: true, intake_prompt_oil_level: true,
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
  // `current` is the card the last scenario ran on — the one to assert against. Every timed
  // scenario gets a fresh one; see run().
  fix = { veh: veh.id, card: card.id, current: card.id, extraCards: [], site: site.id };

  // The dev server disposes inactive pages and serves 404s while it rebuilds one; a gate that
  // drives a page that was never served dies as a bare selector timeout 25s later. Warm it and
  // say so — see serverReady in _gate-preflight.
  const ready = await serverReady();
  check('the dev server serves pages before we drive it', ready.ok, `HTTP ${ready.status} after ${ready.attempts} attempt(s)`);
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
  //
  // ── WHY type() DOES NOT USE fill() ──────────────────────────────────────────────────────────
  // It used to, and that made the first version of this measurement dishonest. Playwright's fill()
  // SETS a value — it does not type — so a 52-character description cost 600ms in the harness and
  // about seventeen seconds in a bay. The reported 9.4s "worst realistic" was therefore the tyre
  // capture (which is pure taps, and stands) plus a free description.
  //
  // pressSequentially with a per-character delay is the repair. KEY_MS is deliberately separate
  // from PACE: finding a control and pressing a key are different motions, and a phone keyboard is
  // much faster per keystroke than a thumb hunting for a chip.
  let taps = 0, keys = 0;
  const tap = async (tid) => { taps++; await page.waitForTimeout(PACE); await page.locator(`[data-testid="${tid}"]`).click(); };
  const type = async (tid, v) => {
    taps++; keys += v.length;
    await page.waitForTimeout(PACE);
    await page.locator(`[data-testid="${tid}"]`).pressSequentially(v, { delay: KEY_MS });
  };

  /**
   * EVERY TIMED SCENARIO STARTS ON A FRESH CARD.
   *
   * This used to re-navigate to the SAME card each time, which worked only because the capture
   * forms had no memory of what they had recorded. Once the tyre form began opening on this
   * visit's readings, every scenario after the first met four collapsed corners and timed out
   * hunting for a chip — and the timeout was the messenger. Each of these rows claims to measure a
   * FIRST capture: a car arriving and being walked around. From the second scenario on, that had
   * quietly stopped being what was measured.
   *
   * Here rather than at each call site, because this is the one place a scenario begins — a caller
   * that forgot would silently measure the wrong thing again.
   */
  async function run(label, plan) {
    const fresh = await prisma.jobCard.create({
      data: { group_id: ZZ, site_id: fix.site, vehicle_id: fix.veh, status: 'in_progress', odometer_in: 61000 },
      select: { id: true },
    });
    fix.extraCards.push(fresh.id);
    fix.current = fresh.id;
    await page.goto(`${B}/m/job/${fresh.id}`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('[data-testid="phone-tyres"]', { timeout: 30000 });
    taps = 0; keys = 0;
    const t0 = Date.now();
    await plan();
    const secs = (Date.now() - t0) / 1000;
    rows.push({ label, taps, keys, secs, thinking: secs - taps * (PACE / 1000) - keys * (KEY_MS / 1000) });
    return secs;
  }

  // ── ORDER, ON THE SERVED PAGE ───────────────────────────────────────────────────────────────
  // Down the screen: what the car needs, then the tyres, then the pictures, then send it. That is
  // the order a walkaround happens in, and getting it from a static read of the JSX would prove
  // only that the file lists them — not that they render.
  console.log('\n— the phone page, top to bottom —');
  await page.goto(`${B}/m/job/${fix.card}`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-testid="phone-tyres"]', { timeout: 30000 });
  // THE ORDER THE MECHANIC ASKED FOR, after using it: the schedule is read off the car's computer
  // before anything is touched, so it comes second; tyres are the longest panel and the least
  // urgent, so they come last. This list is the assertion — reordering the page without reordering
  // this fails, which is the point.
  const order = await page.evaluate(() => ['phone-checklist', 'phone-schedule', 'phone-battery', 'phone-observations', 'phone-findings', 'phone-tyres', 'phone-send-report']
    .map((t) => { const e = document.querySelector(`[data-testid="${t}"]`); return e ? { t, y: e.getBoundingClientRect().top + window.scrollY } : { t, y: null }; }));
  check('every intake section renders on the phone', order.every((o) => o.y !== null),
    order.filter((o) => o.y === null).map((o) => o.t).join(', ') || 'all present');
  // ── EVERY PANEL REFRESHES THE CARD, NOT THE PHOTOS ──────────────────────────────────────────
  // They were all wired onChanged={refreshPhotos}, which fetches /api/photos and nothing else — so
  // a panel that wrote successfully never saw its own result. The audit trail holds six identical
  // oil_level writes inside one minute on 20 Aug 2026: someone tapping again because the chip
  // never lit. load() refetches the job payload; refreshPhotos is for photos.
  const pageSrc = readFileSync('pages/m/job/[id].tsx', 'utf8');
  check('no capture panel is wired to the photo-only refresh',
    !/on(Changed|Queued)=\{refreshPhotos\}/.test(pageSrc),
    'a panel that cannot see its own write reads as a panel that did not write');
  check('  …and all six go to load()', (pageSrc.match(/on(?:Changed|Queued)=\{load\}/g) ?? []).length === 6,
    `${(pageSrc.match(/on(?:Changed|Queued)=\{load\}/g) ?? []).length} of 6`);

  // ── THE TWO PANELS THAT READ AS ONE ─────────────────────────────────────────────────────────
  // "What this car needs" described the schedule panel equally well. Both are a thing plus a
  // clock, and neither said what happens next — which is the only difference that matters at the
  // point of entry: one reaches the customer, one does not.
  // READ OFF THE RENDERED PAGE, not out of the source. The first version grepped the component
  // for the OLD heading and failed against the comment that explains why it was changed — a scan
  // term appearing in its own explanation, for the fourth time in one day. What a mechanic sees is
  // the claim anyway, so assert that.
  const findsText = await page.locator('[data-testid="phone-findings"]').innerText();
  const schedText = await page.locator('[data-testid="phone-schedule"]').innerText();
  check('the findings panel is named for whose observation it is',
    /What you found/.test(findsText) && !/What this car needs/.test(findsText),
    'the old heading described the schedule panel equally well');
  check('  …and says where it ends up', /report and their invoice/.test(findsText));
  check('the schedule panel says the customer is NOT told', /customer isn’t told about these/.test(schedText));
  check('  …so the two panels differ by consequence, not by provenance',
    /customer isn’t told/.test(schedText) && /report and their invoice/.test(findsText),
    'where it came from is what the mechanic already knows; what happens next is what they cannot see');

  // ── THE MILEAGE COLUMN DOES NOT MOVE ────────────────────────────────────────────────────────
  // A pads row has no month leg. Under flex-wrap its mileage box slid into the month's place, so
  // the column of numbers moved depending on the item — measured here rather than eyeballed.
  //
  // EQUAL IS NOT ENOUGH, and a probe proved it: reverting the grid to a flex-wrap made every
  // mileage box wrap onto its own line at the LEFT edge — uniformly wrong, and an all-equal
  // assertion passed. So the rule is pinned, not the coincidence: same x on every row AND flush
  // with the right-hand edge of its row, which is what "the right-hand column" means.
  const cols = await page.evaluate(() => ['schedule_oil_service', 'schedule_pads_front', 'schedule_pads_rear', 'schedule_vehicle_check']
    .map((k) => {
      const e = document.querySelector(`[data-testid="phone-schedule-miles-${k}"]`);
      const row = document.querySelector(`[data-testid="phone-schedule-row-${k}"]`);
      if (!e || !row) return null;
      const a = e.getBoundingClientRect(), b = row.getBoundingClientRect();
      return { left: Math.round(a.left), fromRight: Math.round(b.right - a.right) };
    }));
  check('every mileage box starts at the same x, whatever legs its row has',
    cols.every((c) => c !== null) && new Set(cols.map((c) => c.left)).size === 1,
    JSON.stringify(cols.map((c) => c && c.left)));
  check('  …and sits in the RIGHT-hand column, not merely in the same wrong place',
    cols.every((c) => c && c.fromRight <= 16),
    `distance from each row's right edge: ${JSON.stringify(cols.map((c) => c && c.fromRight))}`);

  // ── AND THE TAP ACKNOWLEDGES ITSELF ─────────────────────────────────────────────────────────
  // The write always worked; the screen never changed, so it read as a dead button. Proven on the
  // served page rather than by wiring: tap a level, and WITHOUT a reload the chip must come back
  // selected. If it does not, someone taps it again — the audit trail holds six of those.
  const oilRow = page.locator('[data-testid="ph-item-oil_level"]');
  check('the oil chips are offered before a level is taken',
    (await page.locator('[data-testid="ph-oil-between"]').count()) === 1);
  await page.locator('[data-testid="ph-oil-between"]').click();
  // THE ACKNOWLEDGEMENT IS THE TICK AND THE READING, not a lit chip: recording a level marks the
  // item done, and the chip row renders only while it is NOT done. The first version of this check
  // waited for the chip to highlight and timed out on a detached element — asserting a state the
  // component cannot reach.
  await page.locator('[data-testid="ph-oil-recorded"]').waitFor({ timeout: 20000 }).catch(() => {});
  check('tapping a level acknowledges itself, with no reload',
    (await page.locator('[data-testid="ph-oil-recorded"]').count()) === 1,
    'the write always worked — six identical audit rows inside one minute say the screen did not');
  check('  …saying WHICH level, not just that something happened',
    /Between/i.test(await oilRow.innerText()),
    'the reading used to vanish at the moment of capture: chips hidden once done, value shown nowhere');
  check('  …and the chips are gone, because the item is done',
    (await page.locator('[data-testid="ph-oil-between"]').count()) === 0);

  const promptCount = await page.locator('[data-testid^="ph-item-"]').count();
  check('  …and the checklist shows the THREE prompts this site switched on, not four', promptCount === 3,
    `${promptCount} items — an unprompted item must never appear, or the escalation names it later`);
  const ys = order.map((o) => o.y);
  check('  …checklist → schedule → battery → spotted-it → what-you-found → tyres → send',
    ys.every((y, i) => i === 0 || (y !== null && ys[i - 1] !== null && y > ys[i - 1])),
    order.map((o) => `${o.t}@${o.y === null ? '—' : Math.round(o.y)}`).join(' · '));
  const mot = await page.locator('[data-testid="phone-mot"]').count();
  check('  …and the MOT sits with the findings, read-only', mot === 1 || mot === 0,
    mot ? 'shown from DVSA' : 'no MOT on this fixture vehicle — nothing to show');

  // ── TYRES ALONE ─────────────────────────────────────────────────────────────────────────────
  // Reported separately because it is the part that is pure taps. Mixing it with a finding hides
  // that the finding is dominated by typing a description, and produces one number that describes
  // neither honestly.
  console.log('\n— tyres alone, no typing at all —');
  await run('T1. tyres, four even', async () => {
    for (const c of ['front_left', 'front_right', 'rear_left', 'rear_right']) await tap(`ph-tyre-${c}-chip-60`);
    await tap('phone-tyre-save');
    await page.waitForSelector('[data-testid="phone-tyres-queued"]', { timeout: 15000 });
  });
  await run('T2. tyres, one split', async () => {
    for (const c of ['front_right', 'rear_left', 'rear_right']) await tap(`ph-tyre-${c}-chip-60`);
    await tap('ph-tyre-front_left-uneven');
    await tap('ph-tyre-front_left-outer-20');
    await tap('ph-tyre-front_left-centre-50');
    await tap('ph-tyre-front_left-inner-60');
    await tap('ph-tyre-front_left-type-winter_standard');
    await tap('phone-tyre-save');
    await page.waitForSelector('[data-testid="phone-tyres-queued"]', { timeout: 15000 });
  });

  // ── OBSERVATIONS ────────────────────────────────────────────────────────────────────────────
  // The prediction, recorded before the measurement: 3 controls / 1.8s for a wiper blade and
  // 4 / 2.4s for a bulb, against ~6 controls plus ~40 keystrokes for the same finding typed. Not
  // "under a second" — the answer tap cannot be defaulted away, and that is the boundary of the
  // speed argument rather than an oversight.
  console.log('\n— spotted it: tapped, not typed —');
  await run('OB1. wiper blade', async () => {
    await tap('phone-observation-wipers_smearing');
    await tap('phone-observation-answer-declined');
    await page.waitForSelector('[data-testid="phone-observations-queued"]', { timeout: 15000 });
  });
  await run('OB2. bulb (two-step)', async () => {
    await tap('phone-observation-bulb-group');
    await tap('phone-observation-bulb_ns_headlight');
    await tap('phone-observation-answer-agreed_later');
    await page.waitForSelector('[data-testid="phone-observations-queued"]', { timeout: 15000 });
  });
  // WAIT FOR THE TWO KEYS, not for a count. "observation_key is not null" also matches the tyre
  // advisories raised by the runs above, so a count-based wait was satisfied before either tap had
  // landed — and then asserted against rows it had not been waiting for. The same under-specified
  // wait that reported a stale battery reading earlier; scoped to the subject this time.
  const WANT = ['wipers_smearing', 'bulb_ns_headlight'];
  let obs = [];
  for (let i = 0; i < 40; i++) {
    obs = await prisma.vehicleDueItem.findMany({
      where: { vehicle_id: fix.veh, observation_key: { in: WANT } },
      select: { observation_key: true, description: true, customer_response: true },
    });
    if (obs.length === WANT.length) break;
    await page.waitForTimeout(500);
  }
  check('both taps reached the database through the queue', obs.length === 2,
    obs.map((o) => o.observation_key).join(', ') || 'neither landed');
  check('  …with the catalogue’s words and no typing at all',
    obs.some((o) => o.description === 'Wiper blades smearing') && obs.some((o) => o.description === 'N/S headlight not working'));
  check('  …and the answer the mechanic actually chose, not a default',
    new Set(obs.map((o) => o.customer_response)).size === 2,
    obs.map((o) => o.customer_response).join(', '));

  // ── BATTERY ─────────────────────────────────────────────────────────────────────────────────
  // Three numbers typed, because a voltage cannot be chipped. Two runs: the first visit, which pays
  // for the rating, and every visit after it, where the rating is remembered and the work is the
  // three numbers alone.
  console.log('\n— the battery test, typed —');
  await run('BT1. battery, first visit', async () => {
    await type('phone-battery-voltage', '11.98');
    await type('phone-battery-soc', '0');
    await type('phone-battery-soh', '17');
    await type('phone-battery-cca', '700');
    await tap('phone-battery-std-EN');
    await tap('phone-battery-save');
    await page.waitForSelector('[data-testid="phone-battery-queued"]', { timeout: 15000 });
  });
  // Let the queue land so the rating is genuinely on the car for the second run.
  for (let i = 0; i < 40; i++) {
    if (await prisma.batteryReading.count({ where: { job_card_id: fix.current } })) break;
    await page.waitForTimeout(500);
  }
  await run('BT2. battery, remembered', async () => {
    await type('phone-battery-voltage', '12.55');
    await type('phone-battery-soc', '92');
    await type('phone-battery-soh', '44');
    await tap('phone-battery-save');
    await page.waitForSelector('[data-testid="phone-battery-queued"]', { timeout: 15000 });
  });
  // Wait for the SECOND envelope. The first wait proved a reading existed, which is not the same
  // as proving the retest landed — reading straight after the enqueue caught the earlier row and
  // reported a stale 17%, an assertion that would have been green on a genuinely broken upsert.
  let bRow = null;
  for (let i = 0; i < 40; i++) {
    bRow = await prisma.batteryReading.findFirst({ where: { job_card_id: fix.current }, select: { rated_cca: true, cca_standard: true, soh_pct: true } });
    if (bRow?.soh_pct === 44) break;
    await page.waitForTimeout(500);
  }
  check('the battery test reached the database through the queue', bRow != null, JSON.stringify(bRow));
  check('  …and one test per visit, corrected not stacked',
    (await prisma.batteryReading.count({ where: { job_card_id: fix.current } })) === 1 && bRow?.soh_pct === 44);
  check('  …with the rating remembered rather than retyped',
    bRow?.rated_cca === 700 && bRow?.cca_standard === 'EN',
    'the second run typed no rating at all and the denominator survived');

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
    console.log(`  ${r.label.padEnd(26)} ${String(r.taps).padStart(2)} controls · ${String(r.keys).padStart(3)} keystrokes · ${r.secs.toFixed(1).padStart(5)}s wall · ${r.thinking.toFixed(1)}s of that is the app`);
  }
  // EXACT labels, not prefixes. 'BT1. battery' also startsWith('B'), so the keystroke check below
  // was reading the battery row and passing on a near-tie — the fixture-name collision rule, met
  // in my own selectors. A row is picked by its whole name or not at all.
  const row = (label) => rows.find((r) => r.label === label);
  const tyresOnly = Math.max(row('T1. tyres, four even').secs, row('T2. tyres, one split').secs);
  check('the TYRE capture, which is all taps, stays inside ten seconds', tyresOnly < 10,
    `${tyresOnly.toFixed(1)}s for the split-corner car — no typing in it at all`);
  const worst = Math.max(...rows.map((r) => r.secs));
  check('the whole capture stays under a minute', worst < 60,
    `${worst.toFixed(1)}s at ${PACE}ms per control and ${KEY_MS}ms per keystroke`);
  const typed = row('B. worst realistic');
  // THE COMPARISON THAT MATTERS: the same kind of finding, tapped versus typed.
  const wiper = row('OB1. wiper blade');
  check('a tapped observation is a fraction of a typed one',
    wiper.secs * 5 < typed.secs,
    `${wiper.secs.toFixed(1)}s tapped vs ${typed.secs.toFixed(1)}s for the typed worst case`);
  check('  …and it costs no keystrokes at all', wiper.keys === 0);
  check('  …but is NOT under a second, because the answer cannot be defaulted',
    wiper.taps === 2 && wiper.secs > 1,
    'two taps: the observation and whether it was raised — the boundary of the speed argument');
  check('  …and the honest reason it is not faster is the keyboard, not the app',
    typed.keys * (KEY_MS / 1000) > typed.taps * (PACE / 1000),
    `${typed.keys} keystrokes cost ${(typed.keys * KEY_MS / 1000).toFixed(1)}s vs ${(typed.taps * PACE / 1000).toFixed(1)}s of tapping — a description is the slow part of a finding`);
  const appTime = Math.max(...rows.map((r) => r.thinking));
  check('  …and almost none of that is the app', appTime < 6,
    `${appTime.toFixed(1)}s outside the human pace — the rest is the hand, which is as it should be`);
  // 15 is measured, not chosen — 9 for the split corner (3 chips + open it up + 3 depths + type +
  // save) and 6 for the finding. It is pinned because it is the number the DESIGN fixed: pace is a
  // multiplier any hand can move, but a sixteenth tap would be somebody's decision, and it should
  // read as one. If this fails, either the capture grew a step or it lost one — both are news.
  const worstTaps = Math.max(...rows.map((r) => r.taps));
  check('the control count has not drifted', worstTaps === 15, `${worstTaps} controls worst case`);

  const readings = await prisma.tyreReading.count({ where: { job_card_id: fix.current } });
  check('and the queue actually delivered', readings === 4, `${readings} readings landed`);
} catch (e) {
  check('timing run completed', false, String(e?.message ?? e).slice(0, 300));
  await explainIfClientStale(B);
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
    await step('cards', () => prisma.jobCard.deleteMany({ where: { id: { in: [fix.card, ...(fix.extraCards ?? [])] } } }));
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
