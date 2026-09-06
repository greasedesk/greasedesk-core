/**
 * File: scripts/overheads-retired-gate.mjs
 * THE OVERHEADS REGISTER IS RETIRED — nothing writes it, and everything that asked it now asks Costs.
 * @gate-requires: server:3000, db
 *
 * ── WHAT WAS ACTUALLY WRONG ─────────────────────────────────────────────────────────────────────
 * Overhead held one amount with no dates, so a rent rise silently restated every closed month. Cost
 * replaced it months ago and every money figure moved across — costsInWindow reads prisma.cost and
 * nothing else. But THREE writers were left behind: the Settings panel, the post-payment setup
 * wizard, and the demo generator. Marketbridge and Kingsford each carry six Overhead rows AND six
 * Cost rows saying the same thing, because the generator never moved.
 *
 * The setup signal was the visible symptom: it counted Overhead rows, so a tenant that had done the
 * work in Costs still read "todo", and the only way to satisfy it was the panel being removed.
 *
 * ── THE TRAP THIS GATE EXISTS TO HOLD SHUT ──────────────────────────────────────────────────────
 * costsInWindow returns `empty: true` — the cost base WITHHELD — only when there are no Cost ROWS.
 * A Cost row with no INSTANCES returns `empty: false, pennies: 0`: a confident £0.00 cost base,
 * which lib/costs's own header says would improve TMBS's net profit by £11,175 and read as good
 * news. So a wizard that creates a cost and does not generate its instances is worse than the
 * panel it replaces. POST /api/costs does not generate; the wizard must PATCH after it.
 *
 * That is asserted through costsInWindow itself, not by counting rows — the defect is a reported
 * figure, and only the function that reports it can show the difference between nought and unknown.
 *
 * Fixtures on ZZ Gate Garage only. Never TMBS. Rows are CREATED and deleted by their own ids, so
 * nothing pre-existing is touched; TMBS is read only, to prove its provenance rows are still there.
 */
import './_gate-preflight.mjs';
const { gatePrisma, explainIfClientStale, serverReady, describeError } = await import('./_gate-preflight.mjs');
import './_ts.mjs';
const { chromium } = await import('/Users/hugh/Developer/greasedesk-core/node_modules/playwright-core/index.mjs');
const { readFileSync, existsSync } = await import('node:fs');
const S = await import('../lib/setup-signals.ts').catch(() => ({}));
const C = await import('../lib/costs.ts').catch(() => ({}));
const prisma = await gatePrisma();

const ZZ = 'c75ac44e-250a-4c90-98ba-a8326e98dad5';
const TMBS = '854d38e7-6dd4-4836-af61-a0d169639a78';
const BASE = process.env.GATE_BASE ?? 'http://localhost:3000';
const out = [];
const check = (n, ok, d = '') => { out.push(ok ? 'P' : 'F'); console.log(`${ok ? '✓' : '✗'} ${n}${d ? `  — ${d}` : ''}`); };
const raw = (f) => (existsSync(f) ? readFileSync(f, 'utf8') : '');
const src = (f) => raw(f).split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
let fix = null, browser = null;

try {
  const site = await prisma.site.findFirst({ where: { group_id: ZZ }, select: { id: true } });

  // ── 1. NOTHING WRITES THE REGISTER ANY MORE ──────────────────────────────────────────────────
  console.log('\n— the three writers that were left behind —');
  check('the Settings panel no longer edits overheads',
    !/\/api\/overheads/.test(src('pages/admin/settings/overheads.tsx')),
    'it is a redirect now, following the headcount.tsx pattern');
  check('  …and redirects to Costs', /\/admin\/costs/.test(src('pages/admin/settings/overheads.tsx')));
  check('the write API is gone', !existsSync('pages/api/overheads.ts'));
  check('the setup wizard posts to /api/costs, not /api/overheads',
    /\/api\/costs/.test(src('pages/admin/setup-wizard.tsx'))
    && !/\/api\/overheads/.test(src('pages/admin/setup-wizard.tsx')));
  check('the wizard API reads Cost rows', /prisma\.cost\.findMany/.test(src('pages/api/setup-wizard.ts'))
    && !/prisma\.overhead\./.test(src('pages/api/setup-wizard.ts')));
  check('the demo generator creates Cost, not Overhead',
    !/prisma\.overhead\.create/.test(src('lib/demo/generate.ts')) && /prisma\.cost\.create/.test(src('lib/demo/generate.ts')),
    'Marketbridge and Kingsford each hold six of each because it did not');

  // ── 2. THE TABLE IS RETAINED AS PROVENANCE ───────────────────────────────────────────────────
  console.log('\n— and the rows that recorded what the figures used to be are still there —');
  const schema = raw('prisma/schema.prisma');
  check('the Overhead model still exists', /^model Overhead \{/m.test(schema),
    'retained: after the carry these rows are the only record of the previous figures');
  const alloc = /^model CostAllocation \{([\s\S]*?)^\}/m.exec(schema)?.[1] ?? '';
  const owners = ['cost_person_id', 'overhead_id', 'cost_id'].filter((o) => new RegExp(`${o}\\s+String\\?`).test(alloc));
  check('CostAllocation still serves all three owners', owners.length === 3,
    `${owners.join(', ')} — it is not an overhead table; four of TMBS's seven rows are headcount`);
  const tmbsOverheads = await prisma.overhead.count({ where: { group_id: TMBS, is_active: true } });
  check('TMBS still holds its three active overheads', tmbsOverheads === 3, `${tmbsOverheads} — read only; not migrated`);
  // THE COMMENT THAT SAID OTHERWISE. costbase-clip-gate asserted these rows "were retired", while
  // all three were active — a claim about data that nothing checked.
  const clip = raw('scripts/costbase-clip-gate.mjs');
  check('costbase-clip-gate no longer claims they were retired',
    !/were retired when costs moved/.test(clip), 'they are active right now');

  // ── 3. THE SETUP SIGNAL COUNTS COSTS ─────────────────────────────────────────────────────────
  console.log('\n— the signal a tenant could not satisfy —');
  const oh = await prisma.overhead.create({
    data: { group_id: ZZ, name: 'GATE FIXTURE overhead', ex_vat_amount_pennies: 100_00, vat_rate: 0, period: 'monthly' },
    select: { id: true },
  });
  fix = { overheadId: oh.id, costId: null };
  const sigA = await S.getSetupSignals?.(ZZ, null);
  check('an Overhead row no longer satisfies it',
    sigA?.signals?.find((s) => s.key === 'overheads')?.state === 'todo',
    `${sigA?.signals?.find((s) => s.key === 'overheads')?.state} — a tenant that had done the work in Costs still read todo`);

  const cost = await prisma.cost.create({
    data: {
      group_id: ZZ, name: 'GATE FIXTURE cost', cadence: 'monthly', charge: 'spread',
      active_from: new Date(Date.UTC(2026, 0, 1)),
      rates: { create: [{ effective_from: new Date(Date.UTC(2026, 0, 1)), amount_pennies: 100_00 }] },
      allocations: { create: [{ group_id: ZZ, site_id: site.id, percent: 100 }] },
    },
    select: { id: true },
  });
  fix.costId = cost.id;
  const sigB = await S.getSetupSignals?.(ZZ, null);
  const sub = sigB?.signals?.find((s) => s.key === 'overheads');
  check('  …and a Cost row does', sub?.state === 'done', String(sub?.state));
  check('  …with the key kept and the link moved', sub?.href === '/admin/costs',
    `key=${sub?.key} href=${sub?.href} — the key is persisted in wizard step config and setup.json`);

  // ── 4. NOUGHT IS NOT UNKNOWN ─────────────────────────────────────────────────────────────────
  // The cost created above has NO instances yet. This is the trap: the register is no longer empty,
  // so the cost base stops being withheld and starts reporting a confident zero.
  console.log('\n— a cost with no instances must not report a cost base of nothing —');
  const win = [new Date(Date.UTC(2026, 0, 1)), new Date(Date.UTC(2026, 6, 1))];
  const before = await C.costsInWindow?.(ZZ, [site.id], win[0], win[1]);
  check('a cost with no instances reports no instances', before?.instanceCount === 0, JSON.stringify(before));
  check('  …and this is exactly why the wizard must generate them',
    before?.empty === false && before?.pennies === 0,
    `${JSON.stringify(before)} — empty:false with pennies:0 is a CONFIDENT nought, which reads as good news`);
  await C.regenerate?.(cost.id, new Date(Date.UTC(2026, 0, 1)), new Date(Date.UTC(2026, 6, 1)));
  const after = await C.costsInWindow?.(ZZ, [site.id], win[0], win[1]);
  check('generating instances makes the figure real', (after?.instanceCount ?? 0) > 0 && (after?.pennies ?? 0) > 0,
    JSON.stringify(after));
  check('the wizard generates after it creates',
    /PATCH/.test(src('pages/admin/setup-wizard.tsx')) && /costId/.test(src('pages/admin/setup-wizard.tsx')),
    'POST /api/costs creates the rate and the allocation but no instances');

  // ── 5. DRIVEN: THE PANEL REDIRECTS AND THE API IS GONE ───────────────────────────────────────
  console.log('\n— and the way a person still reaches it —');
  const ready = await serverReady();
  check('the dev server serves pages before we drive it', ready.ok, `HTTP ${ready.status} after ${ready.attempts} attempt(s)`);
  browser = await chromium.launch({ channel: 'chrome' });
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
  await page.goto(`${BASE}/admin/login`, { waitUntil: 'domcontentloaded' });
  await page.fill('input[type="email"]', 'owner@zzgategarage.test');
  await page.fill('input[type="password"]', 'GateGarage!2026');
  await Promise.all([page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 60000 }), page.click('button[type="submit"]')]);
  check('the browser is actually signed in', !/\/admin\/login/.test(page.url()), page.url());

  await page.goto(`${BASE}/admin/settings/overheads`, { waitUntil: 'domcontentloaded' });
  check('the old panel URL lands on Costs', /\/admin\/costs/.test(page.url()), page.url());

  const posted = await page.evaluate(async () => {
    const r = await fetch('/api/overheads', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'GATE must not write', exVatAmountPennies: 1, period: 'monthly', allocations: [] }) });
    return r.status;
  });
  check('POST /api/overheads is gone', posted === 404, `HTTP ${posted}`);

  // The wizard payload a person actually receives, over HTTP, as the tenant.
  const wiz = await page.evaluate(async () => {
    const r = await fetch('/api/setup-wizard', { cache: 'no-store' });
    return { status: r.status, body: await r.json().catch(() => ({})) };
  });
  const items = wiz.body?.state?.overheads_basic?.items ?? [];
  check('the wizard step lists the Cost row', items.some((i) => i.name === 'GATE FIXTURE cost'),
    `${wiz.status} ${JSON.stringify(items).slice(0, 160)}`);
  check('  …and not the Overhead row', !items.some((i) => i.name === 'GATE FIXTURE overhead'),
    'both exist on this tenant right now, so this distinguishes the two registers');
} catch (e) {
  check('gate run completed', false, describeError(e).slice(0, 300));
  await explainIfClientStale(BASE);
} finally {
  if (browser) await browser.close().catch(() => {});
  if (fix) {
    // Deleted BY THE ID THIS GATE CREATED, never by name or by "the newest row".
    try {
      if (fix.costId) await prisma.cost.delete({ where: { id: fix.costId } });          // rates/instances/allocations cascade
      if (fix.overheadId) await prisma.overhead.delete({ where: { id: fix.overheadId } });
    } catch (e) { console.log(`  teardown: ${describeError(e).slice(0, 120)}`); }
    const leftCost = fix.costId ? await prisma.cost.count({ where: { id: fix.costId } }) : 0;
    const leftOh = fix.overheadId ? await prisma.overhead.count({ where: { id: fix.overheadId } }) : 0;
    const leftInst = fix.costId ? await prisma.costInstance.count({ where: { cost_id: fix.costId } }) : 0;
    check('teardown removed every fixture row', leftCost === 0 && leftOh === 0 && leftInst === 0,
      `cost=${leftCost} overhead=${leftOh} instances=${leftInst}`);
  }
}

console.log(`\n${out.filter((x) => x === 'F').length} failures of ${out.length}`);
await prisma.$disconnect();
process.exit(out.includes('F') ? 1 : 0);
