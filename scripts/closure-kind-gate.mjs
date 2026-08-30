/**
 * File: scripts/closure-kind-gate.mjs
 * WHY A FINDING CLOSED, and what a customer is therefore shown.
 *
 * DE59SXW, invoice 100003222, 20 Aug 2026: the garage topped up the coolant and the oil, and both
 * printed on that visit's invoice as OUTSTANDING advisories. Nothing could say a finding had been
 * resolved during the visit — /api/due-items accepted an optional reason and its only caller sent
 * `{ id }`, so two of TMBS's three closed findings record neither a reason nor a card, and "the
 * garage did it" is indistinguishable from "the customer refused it".
 *
 * ── THE LOAD-BEARING ASSERTION ──────────────────────────────────────────────────────────────────
 * Only `fixed` reaches the customer. A declined finding printed as work done would tell somebody
 * their garage did work they had refused, on a document they keep.
 *
 * Fixtures on ZZ Gate Garage only. Never TMBS.
 */
import './_gate-preflight.mjs';
const { gatePrisma, explainIfClientStale, zzSite, serverReady, describeError } = await import('./_gate-preflight.mjs');
import './_ts.mjs';
const { chromium } = await import('/Users/hugh/Developer/greasedesk-core/node_modules/playwright-core/index.mjs');
const { readFileSync } = await import('node:fs');
const C = await import('../lib/due-item-closure.ts');
const { freezeQuoteVersion } = await import('../lib/quote-version.ts');
const { acceptQuote } = await import('../lib/quote-acceptance.ts');
const { issueInvoiceForCard } = await import('../lib/invoice-issue.ts');
const prisma = await gatePrisma();

const ZZ = 'c75ac44e-250a-4c90-98ba-a8326e98dad5';
const BASE = process.env.GATE_BASE ?? 'http://localhost:3000';
const REG = 'ZZ76CLS';
const CUST = 'Closure Kind Fixture';
const out = [];
const check = (n, ok, d = '') => { out.push(ok ? 'P' : 'F'); console.log(`${ok ? '✓' : '✗'} ${n}${d ? `  — ${d}` : ''}`); };

let fix = null, browser = null;

try {
  const stale = await prisma.customer.count({ where: { group_id: ZZ, name: CUST } });
  if (stale) throw new Error(`REFUSING: ${stale} fixture(s) from a previous run still present`);

  // ── 1. THE RULE, PURE ────────────────────────────────────────────────────────────────────────
  console.log('\n— three outcomes, and only one of them is a claim to the customer —');
  check('only `fixed` prints as work done',
    C.printsAsWorkDone('fixed') && !C.printsAsWorkDone('declined') && !C.printsAsWorkDone('no_longer_applies'),
    'a declined finding printed as done tells somebody their garage did work they refused');
  check('  …and an UNKNOWN closure prints nothing', !C.printsAsWorkDone(null) && !C.printsAsWorkDone(undefined),
    'every closure before 2026-08-20 is null-kind: we do not know, so we say nothing');

  check('`fixed` demands the visit it was fixed on',
    C.refuseClosure({ kind: 'fixed' })?.code === 'fixed_needs_card',
    'it prints on that visit’s invoice; with no card it is a claim nobody can place');
  check('  …and `declined` does NOT', C.refuseClosure({ kind: 'declined' }) === null,
    'a customer declines on the phone in March about a finding from January — demanding a card makes the honest answer unrecordable');
  check('a closure with no kind is refused', C.refuseClosure({ kind: 'sorted' }) !== null);

  const f = C.closureFields({ kind: 'fixed', jobCardId: 'card-1' });
  check('a closure always carries words as well as a kind', f.closed_reason === 'Done on this visit',
    'a kind alone tells a garage nothing when they open the car’s history in a year');
  check('  …and a typed note replaces the default',
    C.closureFields({ kind: 'fixed', note: 'Topped up 400ml', jobCardId: 'x' }).closed_reason === 'Topped up 400ml');

  const block = C.printedWorkDoneBlock([
    { description: 'Coolant below the minimum mark', closedKind: 'fixed' },
    { description: 'Brake discs', closedKind: 'declined' },
    { description: 'Oil level at the minimum mark', closedKind: 'fixed' },
    { description: 'Wiper blades smearing', closedKind: null },
  ]);
  check('the block prints ONLY the fixed ones', /Coolant/.test(block) && /Oil level/.test(block)
    && !/Brake discs/.test(block) && !/Wiper/.test(block), JSON.stringify(block));
  check('  …and nothing at all when nothing was sorted',
    C.printedWorkDoneBlock([{ description: 'x', closedKind: 'declined' }]) === null,
    'an empty heading is worse than no heading');

  // ── 2. THE UI CANNOT CLOSE WITHOUT SAYING WHY ────────────────────────────────────────────────
  const ui = readFileSync('components/jobcard/DueItems.tsx', 'utf8');
  check('the list no longer closes with an id alone',
    !/body: JSON\.stringify\(\{ id \}\)/.test(ui) && /closedKind: kind/.test(ui),
    'the API accepted a reason from the day it was written and no caller ever passed one');
  check('  …and the invoiced-lines prompt closes as `fixed`, by construction',
    /close\(it\.id, 'fixed'\)/.test(ui),
    'that prompt appears only when every linked line is on an issued invoice');

  // ── 3. THROUGH THE REAL PATH, ONTO A REAL DOCUMENT ───────────────────────────────────────────
  console.log('\n— topped up, and the invoice says so —');
  const site = await zzSite(prisma);
  const owner = await prisma.user.findFirst({ where: { group_id: ZZ, email: 'owner@zzgategarage.test' }, select: { id: true } });
  const cust = await prisma.customer.create({ data: { group_id: ZZ, name: CUST, phone: '07700 900777' }, select: { id: true } });
  const veh = await prisma.vehicle.create({
    data: { group_id: ZZ, registration: REG, registration_normalized: REG, make: 'Closure', model: 'Fixture' }, select: { id: true } });
  await prisma.vehicleOwnership.create({ data: { vehicle_id: veh.id, customer_id: cust.id, is_current: true } });
  const card = await prisma.jobCard.create({
    data: { group_id: ZZ, site_id: site.id, customer_id: cust.id, vehicle_id: veh.id, status: 'quoted', odometer_in: 42000 },
    select: { id: true } });
  await prisma.jobCardItem.create({ data: { job_card_id: card.id, item_type: 'labour', description: 'Closure fixture work',
    qty: 1, unit_price: 100, vat_rate: 20, vat_amount: 20, labour_hours: 1 } });
  await freezeQuoteVersion({ groupId: ZZ, jobCardId: card.id, vatRegistered: true, taxLabel: 'VAT' });
  await prisma.$transaction(async (tx) => {
    await acceptQuote(tx, { groupId: ZZ, jobCardId: card.id, via: 'counter', actorUserId: owner.id, attested: null, at: new Date() });
  });
  fix = { veh: veh.id, cust: cust.id, card: card.id };

  const mk = (desc, key) => prisma.vehicleDueItem.create({
    data: { group_id: ZZ, vehicle_id: veh.id, found_on_job_card_id: card.id, observation_key: key,
      description: desc, due_basis: 'next_service', customer_response: 'not_raised' },
    select: { id: true } });
  // ── A PREVIOUS VISIT ON THE SAME CAR ─────────────────────────────────────────────────────────
  // Without this the fixture cannot tell card-scope from car-scope: one card makes both queries
  // return the same rows, and a probe swapping `closed_job_card_id` for `vehicle_id` passed
  // clean. The block describes THIS visit, so last month's fixed finding must not appear on it.
  const older = await prisma.jobCard.create({
    data: { group_id: ZZ, site_id: site.id, customer_id: cust.id, vehicle_id: veh.id, status: 'invoiced', odometer_in: 39000 },
    select: { id: true } });
  await prisma.vehicleDueItem.create({
    data: { group_id: ZZ, vehicle_id: veh.id, found_on_job_card_id: older.id, observation_key: 'bulb_out',
      description: 'Number plate bulb out', due_basis: 'next_service', customer_response: 'not_raised',
      ...C.closureFields({ kind: 'fixed', note: 'Replaced last month', jobCardId: older.id }) } });

  const coolant = await mk('Coolant below the minimum mark', 'coolant_low');
  const declined = await mk('Brake discs worn', 'discs_worn');
  const stillOpen = await mk('Wiper blades smearing', 'wipers_smearing');

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
  // ONTO THE CARD FIRST. Every other gate does this and it is not decoration: the fetches below
  // ride the session cookie from the page they run on, and calling them straight off the login
  // redirect gets 401 with no explanation.
  await page.goto(`${BASE}/admin/jobcards/${card.id}`, { waitUntil: 'domcontentloaded' });

  const patch = (body) => page.evaluate(async (b) => {
    const r = await fetch('/api/due-items', { method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin', body: JSON.stringify(b) });
    return { status: r.status, body: await r.json().catch(() => ({})) };
  }, body);

  // ── `action` IS THE FIRST THING THE ENDPOINT ASKS FOR ────────────────────────────────────────
  // Every PATCH below carries it. It was added when the garage gained a way to record what the
  // customer SAID as well as a way to close a finding, and this gate was left behind as a caller
  // that predates the discriminator — so all four closures came back 400 and seven checks failed
  // describing something else. The product's two callers both send it; only the gate did not.
  const noAction = await patch({ id: coolant.id, closedKind: 'fixed', jobCardId: card.id });
  check('a PATCH that does not say which act it is, is refused', noAction.status === 400
    && noAction.body?.code === 'bad_action', JSON.stringify(noAction));

  const noKind = await patch({ action: 'close', id: coolant.id });
  check('the endpoint refuses a closure with no kind', noKind.status === 400,
    'the shape the old UI sent, now impossible');
  const noCard = await patch({ action: 'close', id: coolant.id, closedKind: 'fixed' });
  check('  …and a `fixed` with no card', noCard.status === 400 && /visit/.test(noCard.body?.message ?? ''),
    noCard.body?.message);

  check('we sorted the coolant', (await patch({ action: 'close', id: coolant.id, closedKind: 'fixed', closedReason: 'Topped up', jobCardId: card.id })).status === 200);
  check('the customer declined the discs', (await patch({ action: 'close', id: declined.id, closedKind: 'declined', jobCardId: card.id })).status === 200);

  const rows = await prisma.vehicleDueItem.findMany({ where: { vehicle_id: veh.id },
    select: { description: true, closed_kind: true, closed_reason: true, closed_job_card_id: true } });
  const c = rows.find((r) => /Coolant/.test(r.description));
  check('  …and the closure records the kind, the words AND the visit',
    c.closed_kind === 'fixed' && c.closed_reason === 'Topped up' && c.closed_job_card_id === card.id,
    `${c.closed_kind} / ${c.closed_reason} / ${c.closed_job_card_id === card.id ? 'this card' : 'NO CARD'}`);

  // THE MINT.
  await page.evaluate(async (b) => { for (const st of ['details', 'intake', 'injob', 'complete']) {
    await fetch('/api/jobcard-stage', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin', body: JSON.stringify({ jobCardId: b, stage: st, done: true }) }); } }, card.id);
  let invId = null;
  await prisma.$transaction(async (tx) => { invId = await issueInvoiceForCard(tx, card.id, ZZ); }, { timeout: 30000 });
  fix.invoice = invId;
  const inv = await prisma.invoice.findUnique({ where: { id: invId }, select: { work_done_snapshot: true, due_items_snapshot: true } });

  check('the invoice says what the visit sorted', /Coolant below the minimum mark/.test(inv.work_done_snapshot ?? ''),
    JSON.stringify(inv.work_done_snapshot));
  check('  …and does NOT list it as still outstanding', !/Coolant/.test(inv.due_items_snapshot ?? ''),
    'the advisory block is what it was on the invoice this whole slice exists because of');
  check('  …the declined finding is in NEITHER block',
    !/Brake discs/.test(inv.work_done_snapshot ?? '') && !/Brake discs/.test(inv.due_items_snapshot ?? ''),
    'closed, so not outstanding; declined, so never presented as done');
  check('  …and a finding still open is still an advisory', /Wiper blades/.test(inv.due_items_snapshot ?? ''),
    stillOpen.id.slice(0, 8));
  check('  …and LAST MONTH’s fixed finding is not on this visit’s invoice',
    !/Number plate bulb/.test(inv.work_done_snapshot ?? ''),
    'the block is scoped to the card, not the car — this is what "describes this visit" means');

  // ── 4. FROZEN, AND THE GOLDENS CANNOT MOVE ───────────────────────────────────────────────────
  await prisma.vehicleDueItem.update({ where: { id: stillOpen.id },
    data: C.closureFields({ kind: 'fixed', note: 'Also sorted, after the mint', jobCardId: card.id }) });
  const after = await prisma.invoice.findUnique({ where: { id: invId }, select: { work_done_snapshot: true } });
  check('closing something AFTER the mint does not rewrite the document',
    !/Wiper blades/.test(after.work_done_snapshot ?? ''),
    'freeze-at-issue: the document says what was true at issue');
  const goldens = readFileSync('scripts/goldens-june.mjs', 'utf8');
  check('work_done_snapshot is NOT in INVOICE_FIELDS — June cannot move',
    !/work_done_snapshot/.test(goldens),
    'the hash moves only when a column is added to that allow-list');

  // ── 5. THE OIL ROW CAN BE RE-RECORDED, WHICH IS WHAT CLOSES ITS ADVISORY ─────────────────────
  console.log('\n— and the door to the closure that already existed —');
  for (const [file, testid] of [['components/jobcard/IntakeChecklist.tsx', 'oil-level-change'],
                                ['components/pwa/PhoneIntakeChecklist.tsx', 'ph-oil-change']]) {
    const src = readFileSync(file, 'utf8');
    check(`${file.split('/').pop()} offers a way back into a done oil level`,
      src.includes(testid) && /reopen\[it\.item\]/.test(src),
      'recording a level marks the item done and the chips render only while it is not — so topping up could not be said');
  }
  const api = readFileSync('pages/api/intake-items.ts', 'utf8');
  check('  …and re-recording a healthy level still closes the finding, attributed',
    /closed_job_card_id: jobCardId, closed_reason: 'Re-checked and within range'/.test(api),
    'the mechanism was never missing — it was unreachable');
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
    await step('quote versions', () => prisma.quoteVersion.deleteMany({ where: { job_card_id: fix.card } }));
    await step('card items', () => prisma.jobCardItem.deleteMany({ where: { job_card_id: fix.card } }));
    await step('due items', () => prisma.vehicleDueItem.deleteMany({ where: { vehicle_id: fix.veh } }));
    await step('cards', () => prisma.jobCard.deleteMany({ where: { vehicle_id: fix.veh } }));
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
