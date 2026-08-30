/**
 * File: scripts/bay-write-gate.mjs
 * A FINISHED JOB TAKES NO NEW BAY DATA — and the way back in is the unlock that already exists.
 *
 * On 2026-08-20 a battery reading was recorded against LL67ZZK's card, status `paid`, invoice
 * issued. Nothing objected: every capture endpoint checked the tenant and the site and none of
 * them checked whether the job was over. The invoice was never at risk — freeze-at-issue protects
 * the document — but the CAR's record was: TyreReading is unique on (job_card_id, corner) and
 * BatteryReading on job_card_id, so a late write OVERWRITES that visit's reading and the wear rate
 * is then computed from a date nobody measured on.
 *
 * Fixtures on ZZ Gate Garage only. Never TMBS.
 */
import './_gate-preflight.mjs';
const { gatePrisma, explainIfClientStale, zzSite, serverReady, describeError } = await import('./_gate-preflight.mjs');
import './_ts.mjs';
const { chromium } = await import('/Users/hugh/Developer/greasedesk-core/node_modules/playwright-core/index.mjs');
const { readFileSync, readdirSync } = await import('node:fs');
const B = await import('../lib/bay-write.ts');
const { freezeQuoteVersion } = await import('../lib/quote-version.ts');
const { acceptQuote } = await import('../lib/quote-acceptance.ts');
const { issueInvoiceForCard } = await import('../lib/invoice-issue.ts');
const prisma = await gatePrisma();

const ZZ = 'c75ac44e-250a-4c90-98ba-a8326e98dad5';
const BASE = process.env.GATE_BASE ?? 'http://localhost:3000';
const REG = 'ZZ76BAY';
const CUST = 'Bay Write Fixture';
const out = [];
const check = (n, ok, d = '') => { out.push(ok ? 'P' : 'F'); console.log(`${ok ? '✓' : '✗'} ${n}${d ? `  — ${d}` : ''}`); };

let fix = null, browser = null;

try {
  const stale = await prisma.customer.count({ where: { group_id: ZZ, name: CUST } });
  if (stale) throw new Error(`REFUSING: ${stale} fixture(s) from a previous run still present`);

  // ── 1. THE RULE, PURE ────────────────────────────────────────────────────────────────────────
  console.log('\n— when a job stops taking bay data —');
  check('a card with no invoice is writable', B.refuseBayWrite({ status: 'in_progress', invoice: null }) === null);
  check('an ISSUED invoice with frozen lines closes it',
    B.refuseBayWrite({ status: 'invoiced', invoice: { status: 'issued', lineCount: 4 } })?.code === 'invoice_frozen');
  check('  …and so does paid', B.refuseBayWrite({ status: 'paid', invoice: { status: 'paid', lineCount: 4 } })?.code === 'invoice_frozen',
    'the reading that started this went onto a paid card');
  check('  …and settled, the warranty terminal',
    B.refuseBayWrite({ status: 'settled', invoice: { status: 'settled', lineCount: 2 } })?.code === 'invoice_frozen');

  // THE REOPENING IS THE UNLOCK, not a new concept. An unlocked invoice is `issued` with NO lines.
  check('an UNLOCKED invoice is writable again',
    B.refuseBayWrite({ status: 'invoiced', invoice: { status: 'issued', lineCount: 0 } }) === null,
    'the admin unlock drops the frozen lines, and that absence IS the unlocked state');
  check('  …which is the ledger’s own predicate, not a second one',
    /canEditInvoice/.test(readFileSync('lib/bay-write.ts', 'utf8')),
    'two ways to ask "is this editable?" is two things to get wrong on every screen');

  check('a cancelled job refuses, with no unlock offered',
    B.refuseBayWrite({ status: 'cancelled', invoice: null })?.code === 'card_inactive',
    'it did not happen; there is no document to correct');
  check('  …and a no-show the same', B.refuseBayWrite({ status: 'no_show', invoice: null })?.code === 'card_inactive');
  check('the refusal says what to do instead',
    /new job card/.test(B.refuseBayWrite({ status: 'paid', invoice: { status: 'paid', lineCount: 1 } }).message),
    'a refusal with no route is how people invent worse workarounds');

  // ── 2. EVERY BAY WRITER ASKS ─────────────────────────────────────────────────────────────────
  console.log('\n— seven writers, one predicate —');
  const WRITERS = ['battery-readings', 'tyre-readings', 'observations', 'service-schedule',
                   'intake-items', 'jobcard-odometer', 'due-items'];
  const missing = WRITERS.filter((w) => !/refuseBayWrite\(/.test(readFileSync(`pages/api/${w}.ts`, 'utf8')));
  check('every capture endpoint consults it', missing.length === 0, missing.join(', ') || WRITERS.length + ' endpoints');
  // AND CLOSING IS DELIBERATELY NOT GUARDED — said out loud, because the next reader will wonder.
  const di = readFileSync('pages/api/due-items.ts', 'utf8');
  check('  …but CLOSING a finding is left open, deliberately',
    /Closing a finding after the invoice is issued is ordinary/.test(di.replace(/\s+/g, ' ')),
    '"we sorted it" and "the customer declined" are both said after the fact');

  // ── 3. ON A REAL, INVOICED JOB ───────────────────────────────────────────────────────────────
  console.log('\n— against a job that has been billed —');
  const site = await zzSite(prisma);
  const owner = await prisma.user.findFirst({ where: { group_id: ZZ, email: 'owner@zzgategarage.test' }, select: { id: true } });
  const cust = await prisma.customer.create({ data: { group_id: ZZ, name: CUST, phone: '07700 900888' }, select: { id: true } });
  const veh = await prisma.vehicle.create({
    data: { group_id: ZZ, registration: REG, registration_normalized: REG, make: 'Bay', model: 'Fixture' }, select: { id: true } });
  await prisma.vehicleOwnership.create({ data: { vehicle_id: veh.id, customer_id: cust.id, is_current: true } });
  const card = await prisma.jobCard.create({
    data: { group_id: ZZ, site_id: site.id, customer_id: cust.id, vehicle_id: veh.id, status: 'quoted', odometer_in: 50000 },
    select: { id: true } });
  await prisma.jobCardItem.create({ data: { job_card_id: card.id, item_type: 'labour', description: 'Bay fixture work',
    qty: 1, unit_price: 100, vat_rate: 20, vat_amount: 20, labour_hours: 1 } });
  await freezeQuoteVersion({ groupId: ZZ, jobCardId: card.id, vatRegistered: true, taxLabel: 'VAT' });
  await prisma.$transaction(async (tx) => {
    await acceptQuote(tx, { groupId: ZZ, jobCardId: card.id, via: 'counter', actorUserId: owner.id, attested: null, at: new Date() });
  });
  fix = { veh: veh.id, cust: cust.id, card: card.id };

  // The dev server disposes inactive pages and serves 404s while it rebuilds one; a gate that
  // drives a page that was never served dies as a bare selector timeout 25s later. Warm it and
  // say so — see serverReady in _gate-preflight.
  const ready = await serverReady();
  check('the dev server serves pages before we drive it', ready.ok, `HTTP ${ready.status} after ${ready.attempts} attempt(s)`);
  browser = await chromium.launch({ channel: 'chrome' });
  const page = await (await browser.newContext()).newPage();
  await page.goto(`${BASE}/admin/login`, { waitUntil: 'domcontentloaded' });
  await page.fill('input[type="email"]', 'owner@zzgategarage.test');
  await page.fill('input[type="password"]', 'GateGarage!2026');
  await Promise.all([page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 60000 }), page.click('button[type="submit"]')]);
  await page.goto(`${BASE}/admin/jobcards/${card.id}`, { waitUntil: 'domcontentloaded' });
  const post = (url, body) => page.evaluate(async ([u, b]) => {
    const r = await fetch(u, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin', body: JSON.stringify(b) });
    return { status: r.status, body: await r.json().catch(() => ({})) };
  }, [url, body]);

  const battery = { jobCardId: card.id, voltage: '12.4', socPct: 80, sohPct: 75, ratedCca: 700, ccaStandard: 'EN' };
  check('before the invoice, the battery records', (await post('/api/battery-readings', battery)).status === 200);

  await page.evaluate(async (id) => { for (const st of ['details', 'intake', 'injob', 'complete']) {
    await fetch('/api/jobcard-stage', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin', body: JSON.stringify({ jobCardId: id, stage: st, done: true }) }); } }, card.id);
  let invId = null;
  await prisma.$transaction(async (tx) => { invId = await issueInvoiceForCard(tx, card.id, ZZ); }, { timeout: 30000 });
  fix.invoice = invId;
  await prisma.jobCard.update({ where: { id: card.id }, data: { status: 'invoiced' } });

  const afterIssue = await post('/api/battery-readings', { ...battery, sohPct: 40 });
  check('after the invoice, it is refused', afterIssue.status === 409 && afterIssue.body?.code === 'invoice_frozen',
    `${afterIssue.status} ${afterIssue.body?.message ?? ''}`);
  const stored = await prisma.batteryReading.findFirst({ where: { vehicle_id: veh.id }, select: { soh_pct: true } });
  check('  …and the visit’s own reading is untouched', stored?.soh_pct === 75,
    `${stored?.soh_pct}% — a late write would have OVERWRITTEN it, the row being unique on job_card_id`);

  for (const [label, url, body] of [
    ['tyres', '/api/tyre-readings', { jobCardId: card.id, corners: [{ corner: 'front_left', type: 'summer_standard', depths: { outer: 60, centre: 60, inner: 60 } }] }],
    ['the dipstick', '/api/intake-items', { jobCardId: card.id, action: 'oil_level', level: 'at_min' }],
    ['mileage out', '/api/jobcard-odometer', { jobCardId: card.id, odometerOut: '50100' }],
    ['the schedule', '/api/service-schedule', { jobCardId: card.id, stage: 'arrival', entries: [{ key: 'schedule_pads_front', dueMonth: null, dueMileage: 60000 }] }],
  ]) {
    const r = await post(url, body);
    check(`  …and so is ${label}`, r.status === 409, `${r.status} ${r.body?.code ?? ''}`);
  }

  // ── 4. THE UNLOCK LETS IT BACK IN ────────────────────────────────────────────────────────────
  console.log('\n— unlocked, and writable again —');
  await prisma.invoiceLine.deleteMany({ where: { invoice_id: invId } }); // what the admin unlock does
  const unlocked = await post('/api/battery-readings', { ...battery, sohPct: 40 });
  check('an unlocked invoice takes the correction', unlocked.status === 200,
    `${unlocked.status} ${unlocked.body?.message ?? ''}`);
  check('  …and it landed', (await prisma.batteryReading.findFirst({ where: { vehicle_id: veh.id }, select: { soh_pct: true } }))?.soh_pct === 40);
} catch (e) {
  check('gate run completed', false, describeError(e).slice(0, 300));
  await explainIfClientStale(BASE);
} finally {
  if (browser) await browser.close().catch(() => {});
  if (fix) {
    const step = async (n, fn) => { try { await fn(); } catch (e) { console.log(`  teardown ${n}: ${describeError(e).slice(0, 90)}`); } };
    if (fix.invoice) {
      await step('invoice lines', () => prisma.invoiceLine.deleteMany({ where: { invoice_id: fix.invoice } }));
      await step('invoice', () => prisma.invoice.deleteMany({ where: { id: fix.invoice } }));
    }
    await step('battery', () => prisma.batteryReading.deleteMany({ where: { vehicle_id: fix.veh } }));
    await step('tyres', () => prisma.tyreReading.deleteMany({ where: { vehicle_id: fix.veh } }));
    await step('readings', () => prisma.serviceScheduleReading.deleteMany({ where: { vehicle_id: fix.veh } }));
    await step('due items', () => prisma.vehicleDueItem.deleteMany({ where: { vehicle_id: fix.veh } }));
    await step('odometer', () => prisma.vehicleOdometerReading.deleteMany({ where: { vehicle_id: fix.veh } }));
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
