/**
 * File: scripts/invoice-snapshot-gate.mjs
 * EVERY SNAPSHOT COLUMN IS DECLARED, AND A RE-ISSUE WRITES THE ONES THAT SAY REBUILD.
 *
 * This gate exists because the same defect has now happened twice, one column apart:
 *   · 100003203 kept £75 of real work through four unlock/re-issue cycles;
 *   · 100003222 kept the tyre depths and the closed advisories it had been corrected about.
 * Both were a column captured at mint with nobody having decided what a RE-issue does with it.
 *
 * ── THE SHAPE, NOT THE INSTANCE ─────────────────────────────────────────────────────────────────
 * Fixing the advisory block alone would leave twelve other columns in the same undecided state. So
 * the assertion is on the SHAPE: every snapshot column on Invoice appears in lib/invoice-snapshots
 * as either `rebuild` or `frozen`-with-a-reason, and a NEW column fails this gate until somebody
 * says which. Undeclared is the failure — not merely un-rebuilt.
 *
 * Fixtures on ZZ Gate Garage only. Never TMBS.
 */
import './_gate-preflight.mjs';
const { explainIfClientStale } = await import('./_gate-preflight.mjs');
import './_ts.mjs';
const { PrismaClient } = await import('@prisma/client');
const { chromium } = await import('/Users/hugh/Developer/greasedesk-core/node_modules/playwright-core/index.mjs');
const { readFileSync } = await import('node:fs');
const S = await import('../lib/invoice-snapshots.ts');
const { freezeQuoteVersion } = await import('../lib/quote-version.ts');
const { acceptQuote } = await import('../lib/quote-acceptance.ts');
const { issueInvoiceForCard } = await import('../lib/invoice-issue.ts');
const prisma = new PrismaClient();

const ZZ = 'c75ac44e-250a-4c90-98ba-a8326e98dad5';
const REG = 'ZZ76SNP';
const CUST = 'Snapshot Policy Fixture';
const out = [];
const check = (n, ok, d = '') => { out.push(ok ? 'P' : 'F'); console.log(`${ok ? '✓' : '✗'} ${n}${d ? `  — ${d}` : ''}`); };

const BASE = process.env.GATE_BASE ?? 'http://localhost:3000';
let fix = null, browser = null;

try {
  const stale = await prisma.customer.count({ where: { group_id: ZZ, name: CUST } });
  if (stale) throw new Error(`REFUSING: ${stale} fixture(s) from a previous run still present`);

  // ── 1. THE REGISTER IS TOTAL ─────────────────────────────────────────────────────────────────
  // Read from the SCHEMA, so a column added tomorrow is caught by this gate and not by a customer.
  console.log('\n— every snapshot column has an answer —');
  const schema = readFileSync('prisma/schema.prisma', 'utf8');
  const model = schema.slice(schema.indexOf('model Invoice {'));
  const body = model.slice(0, model.indexOf('\n}'));
  const columns = [...body.matchAll(/^\s{2}([a-z_]*(?:snapshot|_at_issue))\s+\w/gm)].map((m) => m[1]);
  check('the schema still has the fourteen this was written against', columns.length === 14,
    `${columns.length}: ${columns.join(' ')}`);
  const undeclared = columns.filter((c) => !S.snapshotPolicy(c));
  check('every one is declared rebuild or frozen', undeclared.length === 0,
    undeclared.length ? `UNDECLARED: ${undeclared.join(', ')} — say what a re-issue does with it` : `${columns.length} declared`);
  const stray = S.INVOICE_SNAPSHOTS.filter((s) => !columns.includes(s.column));
  check('  …and the register declares nothing that no longer exists', stray.length === 0,
    stray.map((s) => s.column).join(', ') || 'no stale entries');

  // A `frozen` entry is a DECISION. An empty reason is the undecided state wearing a policy's name.
  const reasonless = S.INVOICE_SNAPSHOTS.filter((s) => s.policy === 'frozen' && (!s.reason || s.reason.trim().length < 20));
  check('every frozen column says WHY rebuilding would be wrong', reasonless.length === 0,
    reasonless.map((s) => s.column).join(', ') || 'all reasoned');

  // ── 2. THE RE-ISSUE PATH WRITES THE REBUILD SET ──────────────────────────────────────────────
  console.log('\n— and the re-issue actually writes them —');
  const reissue = readFileSync('pages/api/invoice-unlock.ts', 'utf8');
  const snap = readFileSync('lib/invoice-issue.ts', 'utf8');
  const written = S.REBUILT_ON_REISSUE.filter((c) => new RegExp(`${c}\\s*:`).test(reissue) || new RegExp(`${c}\\s*:`).test(snap));
  check('every rebuild column is written somewhere on the re-issue path',
    written.length === S.REBUILT_ON_REISSUE.length,
    S.REBUILT_ON_REISSUE.filter((c) => !written.includes(c)).join(', ') || S.REBUILT_ON_REISSUE.join(', '));
  check('  …the narrative blocks through the SHARED computation, not a second copy',
    /computeNarrativeBlocks\(/.test(reissue) && /export async function computeNarrativeBlocks/.test(snap),
    'the mint and the re-issue must describe the car the same way');
  // WRITES, NOT MENTIONS. The first version matched `column:` anywhere and hit the endpoint's own
  // `select` — a frozen column is READ on that path all the time, and reading is not rewriting.
  // Only the payloads of `data: { … }` are searched, which is where a write actually is.
  const dataPayloads = [...reissue.matchAll(/data:\s*\{([\s\S]*?)\}/g)].map((m) => m[1]).join('\n');
  const rewritten = S.INVOICE_SNAPSHOTS.filter((s) => s.policy === 'frozen')
    .filter((s) => new RegExp(`\\b${s.column}\\s*:`).test(dataPayloads));
  check('  …and no frozen column is rewritten there', rewritten.length === 0,
    rewritten.map((r) => r.column).join(', ') || 'rebuilding the parties would restate a past transaction in the present’s terms');
  check('  …and that check looks at writes, not at the select',
    /\bvat_registered_at_issue: true\b/.test(reissue) && !/\bvat_registered_at_issue\s*:/.test(dataPayloads),
    'the endpoint reads a frozen column on every call; the assertion above must not trip on that');

  // ── 3. THE SCREEN SAYS SO BEFORE IT IS PRESSED ───────────────────────────────────────────────
  const ui = readFileSync('pages/admin/invoices/[id].tsx', 'utf8');
  const copy = JSON.parse(readFileSync('public/locales/en-GB/invoice.json', 'utf8'));
  check('the re-issue control explains what it will refresh', /reissueExplains/.test(ui) && !!copy.reissueExplains);
  check('  …and names the part that surprises people', /TODAY/.test(copy.reissueExplains ?? ''),
    'a re-issue in March rebuilds from what the car needs in March');
  check('  …and that the number does not change', /number does not change/i.test(copy.reissueExplains ?? ''));

  // ── 4. END TO END: CORRECT A CAR, RE-ISSUE, READ THE DOCUMENT ────────────────────────────────
  console.log('\n— a document corrected after issue —');
  const site = await prisma.site.findFirst({ where: { group_id: ZZ }, select: { id: true } });
  const owner = await prisma.user.findFirst({ where: { group_id: ZZ, email: 'owner@zzgategarage.test' }, select: { id: true } });
  const cust = await prisma.customer.create({ data: { group_id: ZZ, name: CUST, phone: '07700 900999' }, select: { id: true } });
  const veh = await prisma.vehicle.create({
    data: { group_id: ZZ, registration: REG, registration_normalized: REG, make: 'Snap', model: 'Fixture' }, select: { id: true } });
  await prisma.vehicleOwnership.create({ data: { vehicle_id: veh.id, customer_id: cust.id, is_current: true } });
  const card = await prisma.jobCard.create({
    data: { group_id: ZZ, site_id: site.id, customer_id: cust.id, vehicle_id: veh.id, status: 'quoted', odometer_in: 70000 },
    select: { id: true } });
  await prisma.jobCardItem.create({ data: { job_card_id: card.id, item_type: 'labour', description: 'Snapshot fixture work',
    qty: 1, unit_price: 100, vat_rate: 20, vat_amount: 20, labour_hours: 1 } });
  await freezeQuoteVersion({ groupId: ZZ, jobCardId: card.id, vatRegistered: true, taxLabel: 'VAT' });
  await prisma.$transaction(async (tx) => {
    await acceptQuote(tx, { groupId: ZZ, jobCardId: card.id, via: 'counter', actorUserId: owner.id, attested: null, at: new Date() });
  });
  const wrong = await prisma.vehicleDueItem.create({
    data: { group_id: ZZ, vehicle_id: veh.id, found_on_job_card_id: card.id, observation_key: 'coolant_low',
      description: 'Coolant below the minimum mark', due_basis: 'next_service', customer_response: 'not_raised' },
    select: { id: true } });
  fix = { veh: veh.id, cust: cust.id, card: card.id };

  let invId = null;
  await prisma.$transaction(async (tx) => { invId = await issueInvoiceForCard(tx, card.id, ZZ); }, { timeout: 30000 });
  fix.invoice = invId;
  const atIssue = await prisma.invoice.findUnique({ where: { id: invId }, select: { due_items_snapshot: true, work_done_snapshot: true } });
  check('at issue the coolant is an outstanding advisory', /Coolant/.test(atIssue.due_items_snapshot ?? ''));
  check('  …and nothing is recorded as sorted', atIssue.work_done_snapshot === null);

  // THE CORRECTION: it was topped up, and somebody says so after the invoice went out.
  const C = await import('../lib/due-item-closure.ts');
  await prisma.vehicleDueItem.update({ where: { id: wrong.id },
    data: C.closureFields({ kind: 'fixed', note: 'Topped up', jobCardId: card.id }) });
  // THE UNLOCK, as the admin path performs it: the frozen lines go.
  await prisma.invoiceLine.deleteMany({ where: { invoice_id: invId } });
  const stillStale = await prisma.invoice.findUnique({ where: { id: invId }, select: { due_items_snapshot: true } });
  check('unlocking ALONE leaves the block stale, which is why the screen has to say so',
    /Coolant/.test(stillStale.due_items_snapshot ?? ''),
    'the unlock drops the lines and touches nothing else — correct, and invisible without the sentence');

  // ── THE RE-ISSUE, THROUGH THE REAL ENDPOINT ──────────────────────────────────────────────────
  // Not by calling computeNarrativeBlocks here. The first version did, and a probe that stopped
  // the ENDPOINT calling it still passed this section — the gate was proving the function works,
  // which was never in doubt, and not that the button uses it. The whole defect was a path that
  // did not call something.
  browser = await chromium.launch({ channel: 'chrome' });
  const page = await (await browser.newContext()).newPage();
  await page.goto(`${BASE}/admin/login`, { waitUntil: 'domcontentloaded' });
  await page.fill('input[type="email"]', 'owner@zzgategarage.test');
  await page.fill('input[type="password"]', 'GateGarage!2026');
  await Promise.all([page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 60000 }), page.click('button[type="submit"]')]);
  await page.goto(`${BASE}/admin/invoices/${invId}`, { waitUntil: 'domcontentloaded' });
  const reissued = await page.evaluate(async (id) => {
    const r = await fetch('/api/invoice-unlock', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin', body: JSON.stringify({ invoiceId: id, action: 'reissue' }) });
    return { status: r.status, body: await r.json().catch(() => ({})) };
  }, invId);
  check('the re-issue endpoint accepts it', reissued.status === 200, JSON.stringify(reissued.body).slice(0, 120));

  const after = await prisma.invoice.findUnique({ where: { id: invId }, select: { due_items_snapshot: true, work_done_snapshot: true, _count: { select: { lines: true } } } });
  check('after the re-issue the coolant is no longer outstanding', !/Coolant/.test(after.due_items_snapshot ?? ''),
    JSON.stringify(after.due_items_snapshot));
  check('  …it is recorded as sorted on the visit', /Coolant/.test(after.work_done_snapshot ?? ''),
    JSON.stringify(after.work_done_snapshot));
  check('  …and the money re-froze in the same pass', after._count.lines > 0, `${after._count.lines} lines`);
} catch (e) {
  check('gate run completed', false, String(e?.message ?? e).slice(0, 300));
  await explainIfClientStale(process.env.GATE_BASE ?? 'http://localhost:3000');
} finally {
  if (browser) await browser.close().catch(() => {});
  if (fix) {
    const step = async (n, fn) => { try { await fn(); } catch (e) { console.log(`  teardown ${n}: ${String(e?.message ?? e).slice(0, 90)}`); } };
    if (fix.invoice) {
      await step('invoice lines', () => prisma.invoiceLine.deleteMany({ where: { invoice_id: fix.invoice } }));
      await step('invoice', () => prisma.invoice.deleteMany({ where: { id: fix.invoice } }));
    }
    await step('due items', () => prisma.vehicleDueItem.deleteMany({ where: { vehicle_id: fix.veh } }));
    await step('quote versions', () => prisma.quoteVersion.deleteMany({ where: { job_card_id: fix.card } }));
    await step('card items', () => prisma.jobCardItem.deleteMany({ where: { job_card_id: fix.card } }));
    await step('card', () => prisma.jobCard.deleteMany({ where: { id: fix.card } }));
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
