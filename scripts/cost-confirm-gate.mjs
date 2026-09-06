/**
 * File: scripts/cost-confirm-gate.mjs
 * CONFIRMING A COST MONTH IS A RECORD OF CHECKING — and £0.00 is not a confirmation.
 * @gate-requires: server:3000, db
 *
 * ── THE ZERO ────────────────────────────────────────────────────────────────────────────────────
 * The Costs table puts an "actual" box and a Save beside every month. Clicking Save with the box
 * EMPTY is the obvious gesture for "this month was what we said it would be" — and it sent
 * Number('') → 0. The instance branch guarded `amount < 0` while the cost-creation and rate branches
 * both guard `<= 0` and refuse zero by name: "a cost of nothing is a row that reads as a real cost
 * and contributes nothing — the shape that survives review because every screen looks fine."
 *
 * So an empty box wrote £0.00, marked the month CONFIRMED, and set edited_at — which is the one
 * thing regeneration refuses to overwrite. The month would have been wrong permanently, and the
 * cost base quietly lower. Nobody had hit it: 0 of 381 instances were zero when this was written.
 *
 * ── AND THE CONTROL THAT MAKES THE GESTURE UNNECESSARY ──────────────────────────────────────────
 * `confirmAll` does the whole cost in one act, and refuses the three things a person cannot see:
 * months already confirmed (skipped and counted, so re-clicking is a visible no-op), months whose
 * bill has not fallen due, and any in-scope month sitting at zero — the last refuses the WHOLE act
 * rather than stamping "confirmed" across a figure that is obviously not one.
 *
 * ── NO FIGURE MOVES, WHICH IS THE POINT ─────────────────────────────────────────────────────────
 * costsInWindow sums amount_pennies whatever is_estimate says. Confirming changes no cost base, no
 * net profit, no break-even. Its whole value is the audit row and the edited_at lock, so the gate
 * asserts the money is IDENTICAL either side — if confirming ever moved a figure, it would be doing
 * something nobody asked it to.
 *
 * Fixtures on ZZ Gate Garage only. Never TMBS. One cost is created and deleted by its own id.
 */
import './_gate-preflight.mjs';
const { gatePrisma, explainIfClientStale, serverReady, describeError } = await import('./_gate-preflight.mjs');
import './_ts.mjs';
const { chromium } = await import('/Users/hugh/Developer/greasedesk-core/node_modules/playwright-core/index.mjs');
const C = await import('../lib/costs.ts').catch(() => ({}));
const prisma = await gatePrisma();

const ZZ = 'c75ac44e-250a-4c90-98ba-a8326e98dad5';
const BASE = process.env.GATE_BASE ?? 'http://localhost:3000';
const out = [];
const check = (n, ok, d = '') => { out.push(ok ? 'P' : 'F'); console.log(`${ok ? '✓' : '✗'} ${n}${d ? `  — ${d}` : ''}`); };
const M = (p) => `£${(p / 100).toFixed(2)}`;
let fix = null, browser = null;

const countAudit = async (action) => prisma.auditLog.count({ where: { group_id: ZZ, action } });

try {
  const site = await prisma.site.findFirst({ where: { group_id: ZZ }, select: { id: true } });
  const now = new Date();
  // Three months back, so some occurrences have fallen due and some have not. Stated from `now`
  // rather than hardcoded: a fixture pinned to a date stops testing "past" the moment it ages.
  const from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 3, 1));
  const to = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 4, 1));
  const cost = await prisma.cost.create({
    data: {
      group_id: ZZ, name: 'GATE FIXTURE confirmable', cadence: 'monthly', charge: 'spread', active_from: from,
      rates: { create: [{ effective_from: from, amount_pennies: 100_00 }] },
      allocations: { create: [{ group_id: ZZ, site_id: site.id, percent: 100 }] },
    },
    select: { id: true },
  });
  fix = { costId: cost.id };
  await C.regenerate?.(cost.id, from, to);
  const all = await prisma.costInstance.findMany({ where: { cost_id: cost.id },
    select: { id: true, period_start: true, due_on: true, is_estimate: true }, orderBy: { period_start: 'asc' } });
  const due = all.filter((i) => i.due_on <= now);
  const future = all.filter((i) => i.due_on > now);
  check('the fixture spans both sides of today', due.length >= 3 && future.length >= 2,
    `${due.length} fallen due, ${future.length} not yet, of ${all.length}`);

  const ready = await serverReady();
  check('the dev server serves pages before we drive it', ready.ok, `HTTP ${ready.status} after ${ready.attempts} attempt(s)`);
  browser = await chromium.launch({ channel: 'chrome' });
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 1400 } })).newPage();
  await page.goto(`${BASE}/admin/login`, { waitUntil: 'domcontentloaded' });
  await page.fill('input[type="email"]', 'owner@zzgategarage.test');
  await page.fill('input[type="password"]', 'GateGarage!2026');
  await Promise.all([page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 60000 }), page.click('button[type="submit"]')]);
  check('the browser is actually signed in', !/\/admin\/login/.test(page.url()), page.url());
  const api = (body, method = 'PATCH') => page.evaluate(async ([b, m]) => {
    const r = await fetch('/api/costs', { method: m, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) });
    return { status: r.status, body: await r.json().catch(() => ({})) };
  }, [body, method]);

  // ── 1. AN EMPTY BOX IS NOT A CONFIRMATION ────────────────────────────────────────────────────
  console.log('\n— £0.00 marked confirmed is the worst outcome available —');
  const target = due[0];
  const zeroRes = await api({ instanceId: target.id, amountPennies: 0 });
  check('the instance branch refuses zero', zeroRes.status === 400,
    `HTTP ${zeroRes.status} ${JSON.stringify(zeroRes.body).slice(0, 100)}`);
  const afterZero = await prisma.costInstance.findUnique({ where: { id: target.id },
    select: { amount_pennies: true, is_estimate: true, edited_at: true } });
  check('  …and wrote nothing at all', afterZero.amount_pennies === 100_00
    && afterZero.is_estimate === true && afterZero.edited_at === null, JSON.stringify(afterZero));
  // THE DISCRIMINATING HALF: a real figure still lands, or the check above passes on a dead route.
  const realRes = await api({ instanceId: target.id, amountPennies: 111_00 });
  const afterReal = await prisma.costInstance.findUnique({ where: { id: target.id },
    select: { amount_pennies: true, is_estimate: true, edited_at: true, edited_by: true } });
  check('a real figure is still recorded', realRes.status === 200 && afterReal.amount_pennies === 111_00,
    `HTTP ${realRes.status} ${M(afterReal.amount_pennies)}`);
  check('  …and locks the month against regeneration',
    afterReal.is_estimate === false && afterReal.edited_at !== null && afterReal.edited_by !== null,
    `estimate=${afterReal.is_estimate} edited_at=${!!afterReal.edited_at} by=${afterReal.edited_by}`);

  // ── 2. THE PER-ROW SAVE IS RECORDED ──────────────────────────────────────────────────────────
  // It was the unrecorded path to changing a closed month: edited_by on the row and nothing else.
  const perRow = await countAudit('cost.instance_recorded');
  check('the per-row save writes an audit row', perRow >= 1, `${perRow} rows`);

  // ── 3. CONFIRM-ALL REFUSES A ZERO ANYWHERE IN SCOPE ──────────────────────────────────────────
  // Written directly, as a row predating the fix would be — the route can no longer create one.
  console.log('\n— and one zero refuses the whole act, rather than stamping over it —');
  await prisma.costInstance.update({ where: { id: due[1].id }, data: { amount_pennies: 0 } });
  const beforeRefusal = await prisma.costInstance.count({ where: { cost_id: cost.id, is_estimate: false } });
  const refused = await api({ costId: cost.id, confirmAll: true });
  check('confirmAll refuses while a zero is in scope', refused.status === 400,
    `HTTP ${refused.status} ${JSON.stringify(refused.body).slice(0, 120)}`);
  check('  …and confirmed nothing on the way past',
    (await prisma.costInstance.count({ where: { cost_id: cost.id, is_estimate: false } })) === beforeRefusal,
    'a refusal that half-applied would be worse than none');
  await prisma.costInstance.update({ where: { id: due[1].id }, data: { amount_pennies: 100_00 } });

  // ── 4. CONFIRM-ALL ───────────────────────────────────────────────────────────────────────────
  console.log('\n— what it confirms, and what it leaves alone —');
  const moneyBefore = await C.costsInWindow?.(ZZ, [site.id], from, to);
  const auditBefore = await countAudit('cost.instances_confirmed');
  const res = await api({ costId: cost.id, confirmAll: true });
  check('confirmAll succeeds', res.status === 200, `HTTP ${res.status} ${JSON.stringify(res.body).slice(0, 140)}`);
  check('  …confirming every month whose bill has fallen due, bar the one already done',
    res.body?.confirmed === due.length - 1, `confirmed=${res.body?.confirmed} of ${due.length} due`);
  check('  …and counting the one it skipped', res.body?.skipped === 1, `skipped=${res.body?.skipped}`);
  const futureStill = await prisma.costInstance.count({
    where: { cost_id: cost.id, id: { in: future.map((f) => f.id) }, is_estimate: true } });
  check('  …and never reaching a bill that has not arrived', futureStill === future.length,
    `${futureStill} of ${future.length} future months still estimates`);
  const confirmedRows = await prisma.costInstance.findMany({
    where: { cost_id: cost.id, id: { in: due.map((d) => d.id) } },
    select: { is_estimate: true, edited_at: true, edited_by: true } });
  check('  …setting edited_at and edited_by exactly as the per-row save does',
    confirmedRows.every((r) => r.is_estimate === false && r.edited_at !== null && r.edited_by !== null),
    JSON.stringify(confirmedRows.map((r) => `${r.is_estimate}/${!!r.edited_at}/${!!r.edited_by}`)));

  // ── 5. NO FIGURE MOVED ───────────────────────────────────────────────────────────────────────
  const moneyAfter = await C.costsInWindow?.(ZZ, [site.id], from, to);
  check('the money is identical either side', moneyBefore?.pennies === moneyAfter?.pennies,
    `${M(moneyBefore?.pennies ?? 0)} → ${M(moneyAfter?.pennies ?? 0)} — confirming records a check, it does not restate a cost`);
  check('  …and only the estimate COUNT moved', moneyAfter?.estimateCount < moneyBefore?.estimateCount,
    `${moneyBefore?.estimateCount} → ${moneyAfter?.estimateCount} still estimates`);

  // ── 6. ONE AUDIT ROW FOR THE ACT ─────────────────────────────────────────────────────────────
  const auditAfter = await countAudit('cost.instances_confirmed');
  check('one audit row for the act, not one per month', auditAfter === auditBefore + 1,
    `${auditBefore} → ${auditAfter} for ${res.body?.confirmed} months`);
  const row = await prisma.auditLog.findFirst({ where: { group_id: ZZ, action: 'cost.instances_confirmed' },
    orderBy: { created_at: 'desc' }, select: { entity: true, entity_id: true, diff_json: true } });
  const d = row?.diff_json ?? {};
  check('  …carrying the count, the range and the total',
    typeof d.confirmed === 'number' && !!d.firstPeriod && !!d.lastPeriod && typeof d.totalPennies === 'number',
    JSON.stringify(d));

  // ── 7. RE-CLICKING IS A VISIBLE NO-OP ────────────────────────────────────────────────────────
  const again = await api({ costId: cost.id, confirmAll: true });
  check('re-confirming changes nothing and says so', again.status === 200 && again.body?.confirmed === 0
    && again.body?.skipped === due.length, JSON.stringify(again.body));
  check('  …and writes no audit row for an act that did nothing',
    (await countAudit('cost.instances_confirmed')) === auditAfter, 'a record of nothing buries the records of something');

  // ── 8. THE CONTROL SAYS HOW MANY ─────────────────────────────────────────────────────────────
  console.log('\n— and the button counts before you press it —');
  const cost2 = await prisma.cost.create({
    data: {
      group_id: ZZ, name: 'GATE FIXTURE labelled', cadence: 'monthly', charge: 'spread', active_from: from,
      rates: { create: [{ effective_from: from, amount_pennies: 50_00 }] },
      allocations: { create: [{ group_id: ZZ, site_id: site.id, percent: 100 }] },
    }, select: { id: true },
  });
  fix.costId2 = cost2.id;
  await C.regenerate?.(cost2.id, from, to);
  await page.goto(`${BASE}/admin/costs`, { waitUntil: 'domcontentloaded' });
  const btn = await page.waitForSelector(`[data-testid="confirm-all-${cost2.id}"]`, { timeout: 30000 }).catch(() => null);
  check('the confirm-all control is on the page', !!btn, btn ? 'found' : 'not rendered');
  const label = btn ? (await btn.innerText()).trim() : '';
  check('  …and names the number of months', new RegExp(`Confirm ${due.length} months? at the estimate`, 'i').test(label),
    `"${label}" against ${due.length} fallen due`);
} catch (e) {
  check('gate run completed', false, describeError(e).slice(0, 300));
  await explainIfClientStale(BASE);
} finally {
  if (browser) await browser.close().catch(() => {});
  if (fix) {
    try {
      for (const id of [fix.costId, fix.costId2].filter(Boolean)) await prisma.cost.delete({ where: { id } });
    } catch (e) { console.log(`  teardown: ${describeError(e).slice(0, 120)}`); }
    const left = await prisma.cost.count({ where: { id: { in: [fix.costId, fix.costId2].filter(Boolean) } } });
    const leftInst = await prisma.costInstance.count({ where: { cost_id: { in: [fix.costId, fix.costId2].filter(Boolean) } } });
    check('teardown removed the fixture costs and their instances', left === 0 && leftInst === 0,
      `costs=${left} instances=${leftInst}`);
  }
}

console.log(`\n${out.filter((x) => x === 'F').length} failures of ${out.length}`);
await prisma.$disconnect();
process.exit(out.includes('F') ? 1 : 0);
