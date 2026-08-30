// @gate-timeout: 180
/**
 * File: scripts/invoice-blocks-gate.mjs
 * THE BLOCKS THE SCREEN WAS BUILT TO SHOW, AND DID NOT.
 *
 * Invoice 100003237's PDF printed WHAT WE MEASURED — four tyre rows and a battery row — and the
 * on-screen invoice printed nothing. The data was there, the component rendered it, and the SSR
 * dropped it: getServerSideProps forwarded `dueItemsBlock` and none of the other three, so
 * `props.measuredBlock` was `undefined` and its guard was quietly false.
 *
 * ── ONE OMISSION KILLED THREE OF FOUR BRANCHES ──────────────────────────────────────────────────
 * measuredBlock and workDoneBlock never rendered at all, and `combinedBlocks` being undefined meant
 * the `!combinedBlocks` branches ALWAYS won — so a pre-split document (all three categories in one
 * list, minted before 21 Aug 2026) rendered under "What your car needs" instead of "Advisory — not
 * charged for". The text was right and frozen; the heading described part of what sat under it.
 *
 * ── WHY THE COMPILER SAID NOTHING ───────────────────────────────────────────────────────────────
 * The Props type declares all four. `getServerSideProps` is typed `(ctx: any)` and its returned
 * `props` is never checked against Props, so the page compiled with three required props missing.
 * Same shape as the `as never` enum drift: a type that states the intent while nothing enforces it
 * at the boundary. The typing is the real fix; these checks are what prove it reaches the screen.
 *
 * Fixtures on ZZ Gate Garage only. Never TMBS.
 */
import './_gate-preflight.mjs';
const { zzSite, serverReady, describeError } = await import('./_gate-preflight.mjs');
import './_ts.mjs';
const { PrismaClient } = await import('@prisma/client');
const { chromium } = await import('playwright-core');
const { readFileSync } = await import('node:fs');
const prisma = new PrismaClient();

const ZZ = 'c75ac44e-250a-4c90-98ba-a8326e98dad5';
const BASE = process.env.GATE_BASE ?? 'http://localhost:3000';
const CUST = 'Invoice Blocks Fixture';
const MEASURED = '(1) Front left — 5.0 / 5.0 / 5.0mm\n(2) Battery — 12.47V, 74% charge, 83% health against 760 CCA EN';
const NEEDS = '(1) MOT Expiry 28 April 2027\n(2) Rear brake pads due in 4,000 miles';
const WORK = '(1) Front brake pads replaced';
const out = [];
const check = (n, ok, d = '') => { out.push(ok ? 'P' : 'F'); console.log(`${ok ? '✓' : '✗'} ${n}${d ? `  — ${d}` : ''}`); };
let fix = null, browser = null;

const mk = async (site, tag, seq, snaps) => {
  const veh = await prisma.vehicle.create({ data: { group_id: ZZ, registration: `ZZ76B${tag}`, registration_normalized: `ZZ76B${tag}`, make: 'Blocks', model: tag }, select: { id: true } });
  const card = await prisma.jobCard.create({ data: { group_id: ZZ, site_id: site.id, vehicle_id: veh.id, status: 'invoiced', odometer_in: 60_000, odometer_out: 60_100 }, select: { id: true } });
  const inv = await prisma.invoice.create({ data: {
    group_id: ZZ, site_id: site.id, job_card_id: card.id, series: 'historical', invoice_number: `ZZBLK-${tag}`,
    status: 'issued', sequence_value: seq, company_name_snapshot: 'ZZ Gate Garage',
    customer_name_snapshot: CUST, vat_registered_at_issue: false,
    issued_at: new Date('2026-02-01T00:00:00.000Z'), ...snaps,
  }, select: { id: true } });
  return { veh: veh.id, card: card.id, inv: inv.id };
};

try {
  const stale = await prisma.vehicle.count({ where: { group_id: ZZ, registration: { startsWith: 'ZZ76B' } } });
  if (stale) throw new Error(`REFUSING: ${stale} fixture vehicle(s) from a previous run still present`);
  const site = await zzSite(prisma);
  const ready = await serverReady();
  check('the dev server serves pages before we drive it', ready.ok, `HTTP ${ready.status} after ${ready.attempts} attempt(s)`);

  // A — the reported case: a document with BOTH blocks, the modern shape.
  const A = await mk(site, 'MS', 991_001, { measured_snapshot: MEASURED, due_items_snapshot: NEEDS });
  // B — work done, the block nobody noticed was missing too.
  const B = await mk(site, 'WD', 991_002, { work_done_snapshot: WORK, due_items_snapshot: NEEDS });
  // C — PRE-SPLIT: a needs block and NO measured block is what combinedBlocks means. Not a flag in
  // the data; it is derived, so this fixture is the real shape rather than a simulation of one.
  const C = await mk(site, 'CB', 991_003, { due_items_snapshot: NEEDS });
  fix = { vehs: [A.veh, B.veh, C.veh], cards: [A.card, B.card, C.card], invs: [A.inv, B.inv, C.inv] };

  browser = await chromium.launch({ channel: 'chrome' });
  const page = await (await browser.newContext()).newPage();
  await page.goto(`${BASE}/admin/login`, { waitUntil: 'domcontentloaded' });
  await page.fill('input[type="email"]', 'owner@zzgategarage.test');
  await page.fill('input[type="password"]', 'GateGarage!2026');
  await Promise.all([page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 60000 }), page.click('button[type="submit"]')]);
  const open = async (id) => {
    await page.goto(`${BASE}/admin/invoices/${id}`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('[data-testid="invoice-due-items"]', { timeout: 25000 });
  };

  // ── 1. WHAT WE MEASURED ──────────────────────────────────────────────────────────────────────
  console.log('\n— a document carrying a measured block —');
  await open(A.inv);
  check('the measured block is on the screen', await page.locator('[data-testid="invoice-measured"]').count() === 1,
    'the PDF has printed this all along; the screen dropped it in the props mapping');
  const measuredText = await page.locator('[data-testid="invoice-measured"]').innerText().catch(() => '');
  check('  …carrying the readings, not an empty heading', /12.47V/.test(measuredText) && /5.0 \/ 5.0 \/ 5.0mm/.test(measuredText),
    measuredText.replace(/\s+/g, ' ').slice(0, 90));
  check('  …under its own heading', /What we measured/i.test(measuredText), measuredText.split('\n')[0]);
  check('  …and the needs block is still there beside it',
    /What your car needs/i.test(await page.locator('[data-testid="invoice-due-items"]').innerText()),
    'the one block that survived the mapping must not be lost fixing the others');

  // ── 2. SORTED ON THIS VISIT ──────────────────────────────────────────────────────────────────
  console.log('\n— a document carrying a work-done block —');
  await open(B.inv);
  check('the work-done block is on the screen', await page.locator('[data-testid="invoice-work-done"]').count() === 1,
    'missing for the same single reason, and nobody had noticed');
  check('  …carrying what was sorted', /Front brake pads replaced/.test(
    await page.locator('[data-testid="invoice-work-done"]').innerText().catch(() => '')));

  // ── 3. A PRE-SPLIT DOCUMENT KEEPS ITS OWN HEADING ────────────────────────────────────────────
  // The discriminating half. `combinedBlocks` undefined made !combinedBlocks always true, so this
  // rendered under the WRONG heading while looking entirely correct — the failure mode that
  // survives longest, because the text under it is right.
  console.log('\n— a document minted before the split —');
  await open(C.inv);
  const combined = await page.locator('[data-testid="invoice-due-items"]').innerText();
  check('a pre-split document reads as an ADVISORY', /Advisory — not charged for/i.test(combined),
    combined.split('\n')[0]);
  check('  …and NOT as what the car needs', !/What your car needs/i.test(combined),
    'its list holds all three categories, so the needs heading describes part of what sits under it');
  check('  …and shows no measured block, having none', await page.locator('[data-testid="invoice-measured"]').count() === 0);

  // ── 4. THE TYPING IS THE ACTUAL FIX ──────────────────────────────────────────────────────────
  // Without it the mapping can lose a field again tomorrow and nothing will say so. Pinned on the
  // SSR signature, not on the four names, so adding a fifth prop is covered by construction.
  const src = readFileSync('pages/admin/invoices/[id].tsx', 'utf8');
  check('getServerSideProps is checked against PageProps', /GetServerSideProps<\s*PageProps\s*>/.test(src),
    'the page compiled with three required props missing because its return was never checked');
  for (const f of ['measuredBlock', 'workDoneBlock', 'combinedBlocks', 'dueItemsBlock']) {
    check(`  …and forwards ${f}`, new RegExp(`${f}:\\s*doc\\.${f}`).test(src));
  }
} catch (e) {
  console.log(`\n✗ THREW: ${String(e?.stack ?? e).slice(0, 800)}`);
  out.push('F');
} finally {
  if (browser) await browser.close().catch(() => {});
  if (fix) {
    const step = async (n, f) => { try { await f(); } catch (e) { console.log(`  teardown ${n}: ${describeError(e).slice(0, 110)}`); } };
    await step('invoices', () => prisma.invoice.deleteMany({ where: { id: { in: fix.invs } } }));
    await step('cards', () => prisma.jobCard.deleteMany({ where: { id: { in: fix.cards } } }));
    await step('vehicles', () => prisma.vehicle.deleteMany({ where: { id: { in: fix.vehs } } }));
    try {
      const left = (await prisma.vehicle.count({ where: { id: { in: fix.vehs } } }))
        + (await prisma.invoice.count({ where: { id: { in: fix.invs } } }));
      check('teardown removed every fixture row (ZZ only)', left === 0, `${left} left`);
    } catch (e) { check('teardown removed every fixture row (ZZ only)', false, describeError(e).slice(0, 70)); }
  }
  const f = out.filter((x) => x === 'F').length;
  console.log(`\n${f} failures of ${out.length}`);
  await prisma.$disconnect();
  process.exit(f ? 1 : 0);
}
