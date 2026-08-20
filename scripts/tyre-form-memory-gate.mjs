/**
 * File: scripts/tyre-form-memory-gate.mjs
 * THE TYRE FORM REMEMBERS WHAT IT RECORDED — on the desktop card and on the phone.
 *
 * Both forms seeded blank and never looked at what was stored. After a save and a reload the
 * summary above showed four depths while every chip below sat unselected, no per-corner value
 * rendered, and the counter read "0 of 4". A mechanic could not tell what they had entered and a
 * colleague could not tell whether the tyres had been done at all — on the one panel whose entire
 * job is to say what has been measured. The counter is the part that was actively lying.
 *
 * ── THE SEED IS THIS VISIT, NOT THE CAR ─────────────────────────────────────────────────────────
 * TyreReading is unique on (job_card_id, corner). Seeding from the car's latest — which is what
 * `recorded` holds, correctly, for the summary — would put a reading from a visit last March into
 * today's form, and saving would stamp it as measured today. So the form opens on this card's own
 * rows, supplied separately by lib/jobcard-page-data.
 *
 * ── AND SAVE WRITES ONLY WHAT MOVED ─────────────────────────────────────────────────────────────
 * The upsert sets measured_at to now. A form that knows what it holds must not re-date the three
 * corners nobody touched when somebody edits a fourth.
 *
 * Fixtures on ZZ Gate Garage only. Never TMBS.
 */
import './_gate-preflight.mjs';
const { explainIfClientStale } = await import('./_gate-preflight.mjs');
import './_ts.mjs';
const { PrismaClient } = await import('@prisma/client');
const { chromium } = await import('/Users/hugh/Developer/greasedesk-core/node_modules/playwright-core/index.mjs');
const { readFileSync } = await import('node:fs');
const prisma = new PrismaClient();

const ZZ = 'c75ac44e-250a-4c90-98ba-a8326e98dad5';
const BASE = process.env.GATE_BASE ?? 'http://localhost:3000';
const REG = 'ZZ76TYM';
const CUST = 'Tyre Memory Fixture';
const out = [];
const check = (n, ok, d = '') => { out.push(ok ? 'P' : 'F'); console.log(`${ok ? '✓' : '✗'} ${n}${d ? `  — ${d}` : ''}`); };

let fix = null, browser = null;

try {
  const stale = await prisma.customer.count({ where: { group_id: ZZ, name: CUST } });
  if (stale) throw new Error(`REFUSING: ${stale} fixture(s) from a previous run still present`);

  const site = await prisma.site.findFirst({ where: { group_id: ZZ }, select: { id: true } });
  const cust = await prisma.customer.create({ data: { group_id: ZZ, name: CUST, phone: '07700 900654' }, select: { id: true } });
  const veh = await prisma.vehicle.create({
    data: { group_id: ZZ, registration: REG, registration_normalized: REG, make: 'Tyre', model: 'Memory' }, select: { id: true } });
  await prisma.vehicleOwnership.create({ data: { vehicle_id: veh.id, customer_id: cust.id, is_current: true } });
  const card = await prisma.jobCard.create({
    data: { group_id: ZZ, site_id: site.id, customer_id: cust.id, vehicle_id: veh.id, status: 'accepted' }, select: { id: true } });
  fix = { veh: veh.id, cust: cust.id, card: card.id };

  browser = await chromium.launch({ channel: 'chrome' });
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto(`${BASE}/admin/login`, { waitUntil: 'domcontentloaded' });
  await page.fill('input[type="email"]', 'owner@zzgategarage.test');
  await page.fill('input[type="password"]', 'GateGarage!2026');
  await Promise.all([page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 60000 }), page.click('button[type="submit"]')]);

  // Details, so Intake unlocks — through the real stage API, not by setting the flag.
  await page.evaluate(async (b) => fetch('/api/jobcard-stage', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin', body: JSON.stringify(b) }).then((r) => r.status),
    { jobCardId: card.id, stage: 'details', done: true });

  // ── 1. AN EMPTY FORM IS HONEST ABOUT BEING EMPTY ─────────────────────────────────────────────
  console.log('\n— nothing measured yet —');
  const open = async () => {
    await page.goto(`${BASE}/admin/jobcards/${card.id}?tab=intake`, { waitUntil: 'domcontentloaded' });
    await page.locator('[data-testid="tyre-capture"]').waitFor({ timeout: 25000 });
  };
  await open();
  check('the counter reads 0 of 4 before anything is recorded',
    (await page.locator('[data-testid="tyre-progress"]').innerText()).trim() === '0 of 4');
  check('  …and the chips are showing, because there is nothing to collapse',
    (await page.locator('[data-testid="tyre-front_left-chip-60"]').count()) === 1
    && (await page.locator('[data-testid="tyre-front_left-change"]').count()) === 0);
  check('  …and Save is offered nothing to do',
    (await page.locator('[data-testid="tyre-save"]').innerText()).trim() === 'Nothing to save');

  // ── 2. FOUR CORNERS, THROUGH THE FORM ────────────────────────────────────────────────────────
  console.log('\n— measured through the panel —');
  for (const [corner, v] of [['front_left', 60], ['front_right', 60], ['rear_left', 70], ['rear_right', 70]]) {
    await page.locator(`[data-testid="tyre-${corner}-chip-${v}"]`).click();
  }
  check('the counter counts up as corners are tapped',
    (await page.locator('[data-testid="tyre-progress"]').innerText()).trim() === '4 of 4');
  check('  …and Save now offers all four', /Save all four/.test(await page.locator('[data-testid="tyre-save"]').innerText()));
  await page.locator('[data-testid="tyre-save"]').click();
  await page.locator('[data-testid="tyre-saved"]').waitFor({ timeout: 25000 });
  const stored = await prisma.tyreReading.findMany({ where: { job_card_id: card.id },
    select: { corner: true, depth_outer_tenths: true, measured_at: true } });
  check('four readings are stored', stored.length === 4, stored.map((r) => `${r.corner}:${r.depth_outer_tenths}`).join(' '));

  // ── 3. THE DEFECT: WHAT THE FORM SAYS ON THE WAY BACK IN ─────────────────────────────────────
  console.log('\n— reopened, and this is what was wrong —');
  await open();
  check('the counter reads 4 of 4, not 0 of 4',
    (await page.locator('[data-testid="tyre-progress"]').innerText()).trim() === '4 of 4',
    '"0 of 4" over four stored corners is a lie the page tells about itself');
  check('every corner shows the depth that was recorded',
    (await page.locator('[data-testid="tyre-done-front_left"]').innerText()).trim() === '6.0mm'
    && (await page.locator('[data-testid="tyre-done-rear_right"]').innerText()).trim() === '7.0mm');
  check('  …collapsed, with a way to change it',
    (await page.locator('[data-testid="tyre-front_left-change"]').count()) === 1
    && (await page.locator('[data-testid="tyre-front_left-chip-60"]').count()) === 0,
    'the value is the point; the eight chips that produced it are not');
  check('  …and Save has nothing to do, because nothing has changed',
    (await page.locator('[data-testid="tyre-save"]').innerText()).trim() === 'Nothing to save',
    'a button offering to save four corners that are already saved is the same lie in reverse');

  // ── 4. CHANGE ONE, AND ONLY ONE MOVES ────────────────────────────────────────────────────────
  console.log('\n— one corner re-measured —');
  const before = new Map(stored.map((r) => [r.corner, r.measured_at.getTime()]));
  await page.locator('[data-testid="tyre-front_left-change"]').click();
  check('Change reopens the chips', (await page.locator('[data-testid="tyre-front_left-chip-30"]').count()) === 1);
  await page.locator('[data-testid="tyre-front_left-chip-30"]').click();
  check('  …and Save offers exactly the one that moved',
    (await page.locator('[data-testid="tyre-save"]').innerText()).trim() === 'Save 1',
    'not four — the other three were not re-measured');
  await page.locator('[data-testid="tyre-save"]').click();
  await page.locator('[data-testid="tyre-saved"]').waitFor({ timeout: 25000 });
  const after = await prisma.tyreReading.findMany({ where: { job_card_id: card.id },
    select: { corner: true, depth_outer_tenths: true, measured_at: true } });
  const fl = after.find((r) => r.corner === 'front_left');
  check('the changed corner is written', fl?.depth_outer_tenths === 30, String(fl?.depth_outer_tenths));
  check('  …and the other three keep the time they were measured',
    after.filter((r) => r.corner !== 'front_left').every((r) => r.measured_at.getTime() === before.get(r.corner)),
    'the upsert re-dates on write, so sending an untouched corner would move it');

  // ── 5. THE PHONE, SAME DEFECT, SAME FIX ──────────────────────────────────────────────────────
  console.log('\n— and on the phone —');
  const phone = await (await browser.newContext({ viewport: { width: 390, height: 844 },
    storageState: await ctx.storageState() })).newPage();
  await phone.goto(`${BASE}/m/job/${card.id}`, { waitUntil: 'domcontentloaded' });
  await phone.locator('[data-testid="ph-tyre-front_left"]').waitFor({ timeout: 30000 });
  check('the phone form opens on what this visit recorded',
    (await phone.locator('[data-testid="phone-tyre-progress"]').innerText()).trim() === '4 of 4');
  check('  …collapsed, with Change', (await phone.locator('[data-testid="ph-tyre-front_left-change"]').count()) === 1
    && (await phone.locator('[data-testid="ph-tyre-front_left-chip-60"]').count()) === 0);
  check('  …and its Save has nothing to do either',
    /Nothing to save/.test(await phone.locator('[data-testid="phone-tyre-save"]').innerText()));

  // ── 5b. THE PHONE PAINTS FROM CACHE FIRST, AND THE CACHE CAN PREDATE THE FIELD ───────────────
  // The defining behaviour of this surface: cacheGet paints the last-known payload before the
  // network answers. A phone that cached this card BEFORE tyresOnThisCard existed paints a job
  // object without it — and the seed is a useState INITIALISER, which runs once, on that paint.
  // The fresh payload arrives milliseconds later and cannot re-seed anything.
  //
  // Simulated by stripping the field from the stored entry, which is exactly the state a returning
  // phone is in. Section 5 above passed only because a fresh browser context has no cache at all —
  // the gate was testing a phone that had never been used.
  console.log('\n— the phone, returning with a cache from before the field existed —');
  await phone.evaluate(async (cardId) => {
    const db = await new Promise((res) => { const r = indexedDB.open('gd-outbox', 1); r.onsuccess = () => res(r.result); });
    const key = `job:${cardId}`;
    const entry = await new Promise((res) => {
      const t = db.transaction('cache', 'readonly').objectStore('cache').get(key);
      t.onsuccess = () => res(t.result);
    });
    if (entry?.value) {
      delete entry.value.tyresOnThisCard;
      await new Promise((res) => { const t = db.transaction('cache', 'readwrite').objectStore('cache').put(entry); t.onsuccess = () => res(null); });
    }
  }, card.id);
  await phone.goto(`${BASE}/m/job/${card.id}`, { waitUntil: 'domcontentloaded' });
  await phone.locator('[data-testid="ph-tyre-front_left"]').waitFor({ timeout: 30000 });
  // WAITED FOR, not sampled. A cache-first surface is SUPPOSED to paint last-known first, so a
  // brief "0 of 4" is correct behaviour, not the defect. The claim is that it SETTLES once the
  // network answers — reading the counter immediately just races the paint.
  const settled = await phone.waitForFunction(() => {
    const e = document.querySelector('[data-testid="phone-tyre-progress"]');
    return !!e && e.textContent.trim() === '4 of 4';
  }, { timeout: 15000 }).then(() => true).catch(() => false);
  check('the form still opens on this visit’s readings after a stale first paint', settled,
    `counter stuck at "${(await phone.locator('[data-testid="phone-tyre-progress"]').innerText()).trim()}" — the fresh payload arrived and the form did not take it`);
  check('  …and Save still has nothing to do',
    /Nothing to save/.test(await phone.locator('[data-testid="phone-tyre-save"]').innerText()),
    'if the seed missed, every corner looks changed and one tap re-dates all four');

  // ── 6. THE SEED IS THE VISIT, NOT THE CAR ────────────────────────────────────────────────────
  console.log('\n— a second visit does not inherit the first —');
  const card2 = await prisma.jobCard.create({
    data: { group_id: ZZ, site_id: site.id, customer_id: cust.id, vehicle_id: veh.id, status: 'accepted',
      stage_details_done: true }, select: { id: true } });
  fix.card2 = card2.id;
  await page.goto(`${BASE}/admin/jobcards/${card2.id}?tab=intake`, { waitUntil: 'domcontentloaded' });
  await page.locator('[data-testid="tyre-capture"]').waitFor({ timeout: 25000 });
  check('the new card opens EMPTY, though the car has four readings',
    (await page.locator('[data-testid="tyre-progress"]').innerText()).trim() === '0 of 4',
    'seeding from the car would put March’s figures in today’s form and re-date them on save');
  check('  …while still showing what the car says, above the form',
    (await page.locator('[data-testid="tyre-capture"]').innerText()).includes('6.0'),
    'the summary is the car; the form is the visit');

  // ── 7. ONE RULE, BOTH SURFACES ───────────────────────────────────────────────────────────────
  const d = readFileSync('components/jobcard/TyreCapture.tsx', 'utf8');
  const m = readFileSync('components/pwa/PhoneTyres.tsx', 'utf8');
  check('neither form still seeds blank', !/useState<Record<TyreCorner, Corner>>\(\{/.test(d)
    && !/useState<Record<Corner, C>>\(\{/.test(m));
  check('both seed from this card’s rows', /seedFrom\(onThisCard/.test(d) && /seedFrom\(onThisCard/.test(m));
  check('both send only what changed', /!unchanged\(state\[key\], seed\[key\]\)/.test(d) && /!same\(s\[k\], base\[k\]\)/.test(m));
} catch (e) {
  check('gate run completed', false, String(e?.message ?? e).slice(0, 300));
  await explainIfClientStale(BASE);
} finally {
  if (browser) await browser.close().catch(() => {});
  if (fix) {
    const step = async (n, f) => { try { await f(); } catch (e) { console.log(`  teardown ${n}: ${String(e?.message ?? e).slice(0, 90)}`); } };
    const cards = [fix.card, fix.card2].filter(Boolean);
    await step('readings', () => prisma.tyreReading.deleteMany({ where: { vehicle_id: fix.veh } }));
    await step('due items', () => prisma.vehicleDueItem.deleteMany({ where: { vehicle_id: fix.veh } }));
    await step('odometer', () => prisma.vehicleOdometerReading.deleteMany({ where: { vehicle_id: fix.veh } }));
    await step('cards', () => prisma.jobCard.deleteMany({ where: { id: { in: cards } } }));
    await step('edges', () => prisma.vehicleOwnership.deleteMany({ where: { vehicle_id: fix.veh } }));
    await step('vehicle', () => prisma.vehicle.deleteMany({ where: { group_id: ZZ, registration: REG } }));
    await step('customer', () => prisma.customer.deleteMany({ where: { group_id: ZZ, name: CUST } }));
    check('teardown removed every fixture row (ZZ only)',
      (await prisma.vehicle.count({ where: { group_id: ZZ, registration: REG } })) === 0
      && (await prisma.customer.count({ where: { group_id: ZZ, name: CUST } })) === 0);
  }
}

console.log(`\n${out.filter((x) => x === 'F').length} failures of ${out.length}`);
await prisma.$disconnect();
process.exit(out.includes('F') ? 1 : 0);
