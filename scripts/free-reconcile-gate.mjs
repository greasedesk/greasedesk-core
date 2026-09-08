/**
 * File: scripts/free-reconcile-gate.mjs
 * FREE AND SUBSCRIBED ARE MUTUALLY EXCLUSIVE, AND SOMETHING NOTICES.
 * @gate-requires: server:3000, db
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────────────────────────────
 * TMBS was set free on 5 September and took a real subscription on 6 September. Nothing in the
 * codebase noticed, and the contradiction broke two things silently: refuseDemoBilling refused the
 * tenant its own Stripe portal, and the dashboard banner returned null so nothing said a charge was
 * coming. It was found by a person looking at a screen.
 *
 * Two writers can produce that state and neither could refuse:
 *   · free_since had NO writer but a script typing `data: { free_since: new Date() }`;
 *   · the Stripe cache writer had never heard of free_since.
 * This drives both, and the SECOND is the one that would have caught TMBS.
 *
 * ── THE DISCRIMINATING CASES ARE THE POINT ──────────────────────────────────────────────────────
 * "The flag was cleared" is also true of a function that clears it every time. So a `canceled`
 * subscription arriving must change NOTHING, and the audit rows must not appear. Likewise a demo
 * acquiring a subscription must NOT be quietly reconciled — that is a bug to shout about, and
 * is_demo/is_internal are asserted untouched through the same call that clears free_since.
 *
 * ── THE REFUSAL IS DRIVEN OVER HTTP, WITHOUT A STRIPE KEY ───────────────────────────────────────
 * There is no STRIPE_SECRET_KEY here. Until the guard moved above getStripe(), /api/stripe/checkout
 * answered 503 "billing isn't configured" and the refusal was unreachable — a gate written against
 * it would have returned 503 red and 503 green and asserted nothing. That the check below can
 * distinguish 403 from 503 at all is the evidence the move landed.
 *
 * Fixtures on ZZ Gate Garage only. Never TMBS. This one moves MORE than the others — Group flags,
 * the whole GroupBilling row, and the GroupFeature rows the cache writer upserts as a side effect —
 * so every one is captured before and restored after, asserted field by field, and feature rows
 * that did not exist beforehand are deleted rather than left behind.
 *
 * AUDIT ROWS ARE LEFT IN PLACE. They are true records of what happened to ZZ, and AuditLog rows are
 * never deleted (standing rule). This gate therefore adds a few rows to ZZ's ledger on every run.
 */
import './_gate-preflight.mjs';
const { gatePrisma, explainIfClientStale, serverReady, describeError, gateOrigin } = await import('./_gate-preflight.mjs');
import './_ts.mjs';
const { chromium } = await import('/Users/hugh/Developer/greasedesk-core/node_modules/playwright-core/index.mjs');
const F = await import('../lib/free-tenant.ts').catch(() => ({}));
const D = await import('../lib/demo-tenant.ts').catch(() => ({}));
const C = await import('../lib/stripe-billing-cache.ts').catch(() => ({}));
const prisma = await gatePrisma();

const ZZ = 'c75ac44e-250a-4c90-98ba-a8326e98dad5';
const OPERATOR_ID = 'acab39ee-aea8-4ae8-b855-312007bebdb2';
const BASE = gateOrigin();
const out = [];
const check = (n, ok, d = '') => { out.push(ok ? 'P' : 'F'); console.log(`${ok ? '✓' : '✗'} ${n}${d ? `  — ${d}` : ''}`); };
const resSpy = () => ({ code: null, body: null, status(c) { this.code = c; return { json: (b) => { this.body = b; } }; } });
/** A Stripe subscription, shaped exactly as the cache writer reads it. No key, no network. */
const fakeSub = (status) => ({ id: 'sub_GATEFIXTURE', status, customer: 'cus_GATEFIXTURE',
  items: { data: [] }, current_period_end: null, trial_end: null });

const countAudits = async () => ({
  sa: await prisma.superAdminAudit.count({ where: { target_group_id: ZZ, action: { in: ['tenant.free_flag_set', 'tenant.free_flag_cleared'] } } }),
  saCleared: await prisma.superAdminAudit.count({ where: { target_group_id: ZZ, action: 'tenant.free_flag_cleared' } }),
  al: await prisma.auditLog.count({ where: { group_id: ZZ, action: { in: ['billing.free_flag_set', 'billing.free_flag_cleared'] } } }),
  alCleared: await prisma.auditLog.count({ where: { group_id: ZZ, action: 'billing.free_flag_cleared' } }),
});
const freeOf = async () => (await prisma.group.findUnique({ where: { id: ZZ },
  select: { free_since: true, free_reason: true, is_demo: true, is_internal: true } }));

let fix = null, browser = null;

try {
  const beforeGroup = await prisma.group.findUnique({ where: { id: ZZ },
    select: { is_demo: true, is_internal: true, free_since: true, free_reason: true, trial_ends_at: true } });
  const beforeBilling = await prisma.groupBilling.findUnique({ where: { group_id: ZZ } });
  const beforeFeatures = await prisma.groupFeature.findMany({ where: { group_id: ZZ },
    select: { feature_key: true, enabled: true, source: true } });
  fix = { beforeGroup, beforeBilling, beforeFeatures };

  // ── 1. THE THREE POPULATIONS GET THREE SENTENCES ─────────────────────────────────────────────
  console.log('\n— one refusal served three populations and described one —');
  const r = (g) => { try { return D.billingRefusalFor?.(g) ?? null; } catch { return null; } };
  const demo = r({ is_demo: true }), internal = r({ is_internal: true }), free = r({ free_since: new Date() });
  check('a demo is refused as a demo', demo?.code === 'demo_tenant', JSON.stringify(demo?.code));
  check('  …and told nothing in it is real', /nothing in it is real/i.test(demo?.message ?? ''), demo?.message ?? '(none)');
  check('an internal tenant has its own code', internal?.code === 'internal_tenant', JSON.stringify(internal?.code));
  check('  …and is NOT called a demo', (internal?.message ?? '').length > 20 && !/demo|nothing in it is real/i.test(internal.message),
    internal?.message ?? '(none)');
  check('a free tenant has its own code', free?.code === 'free_tenant', JSON.stringify(free?.code));
  check('  …and is NOT called a demo', (free?.message ?? '').length > 20 && !/demo|nothing in it is real/i.test(free.message),
    free?.message ?? '(none)');
  check('  …and is told it is not billed', /billed|charge/i.test(free?.message ?? ''), free?.message ?? '(none)');
  // A TENANT THAT CAN SUBSCRIBE IS NOT REFUSED. Without this every check above passes on a
  // function that refuses everybody.
  check('a paying tenant is not refused at all', r({ is_demo: false, is_internal: null, free_since: null }) === null,
    JSON.stringify(r({})));
  check('a demo that is ALSO free is refused as a demo', r({ is_demo: true, free_since: new Date() })?.code === 'demo_tenant',
    'the strongest claim wins; a demo is a demo first');

  // ── 2. setFree REFUSES A LIVE SUBSCRIPTION ───────────────────────────────────────────────────
  console.log('\n— a tenant that is being charged cannot be declared free —');
  await prisma.group.update({ where: { id: ZZ }, data: { free_since: null, free_reason: null, is_internal: null } });
  await prisma.groupBilling.update({ where: { group_id: ZZ }, data: { subscription_status: 'trialing' } });
  const refused = await F.setFree?.({ groupId: ZZ, reason: 'Gate: must be refused, this tenant is being charged', operatorUserId: OPERATOR_ID }).catch((e) => ({ ok: false, code: String(e).slice(0, 40) }));
  check('setFree refuses a live subscription', refused?.ok === false && refused?.code === 'live_subscription',
    JSON.stringify(refused));
  check('  …and wrote nothing', (await freeOf())?.free_since === null, String((await freeOf())?.free_since));

  // ── 3. setFree WRITES, AND WRITES BOTH LEDGERS ───────────────────────────────────────────────
  console.log('\n— and one that is not, can be —');
  await prisma.groupBilling.update({ where: { group_id: ZZ }, data: { subscription_status: null } });
  const a0 = await countAudits();
  const set = await F.setFree?.({ groupId: ZZ, reason: 'Gate fixture: proving the writer refuses and records', operatorUserId: OPERATOR_ID }).catch((e) => ({ ok: false, code: String(e).slice(0, 60) }));
  check('setFree writes the decision', set?.ok === true, JSON.stringify(set));
  check('  …the tenant is free, with the reason given', !!(await freeOf())?.free_since
    && (await freeOf())?.free_reason?.includes('proving the writer refuses'), (await freeOf())?.free_reason ?? '(none)');
  const a1 = await countAudits();
  check('  …a SuperAdminAudit row was written', a1.sa === a0.sa + 1, `${a0.sa} → ${a1.sa}`);
  check('  …and one on the TENANT\'S own ledger', a1.al === a0.al + 1, `${a0.al} → ${a1.al}`);
  check('setFree refuses a tenant that is already free', (await F.setFree?.({ groupId: ZZ, reason: 'Gate: already free', operatorUserId: OPERATOR_ID }))?.code === 'already_free');

  // ── 4. THE WEBHOOK CLEARS IT — THE CASE THAT WOULD HAVE CAUGHT TMBS ──────────────────────────
  console.log('\n— a live subscription arriving overtakes the decision —');
  const a2 = await countAudits();
  await C.applyStripeSubscriptionToCache?.(fakeSub('trialing'), ZZ);
  const afterLive = await freeOf();
  check('the free flag is gone', afterLive?.free_since === null, String(afterLive?.free_since));
  check('  …and the reason with it', afterLive?.free_reason === null, String(afterLive?.free_reason));
  const a3 = await countAudits();
  check('  …a SuperAdminAudit row records the clear', a3.saCleared === a2.saCleared + 1, `${a2.saCleared} → ${a3.saCleared}`);
  check('  …and the tenant\'s own ledger too', a3.alCleared === a2.alCleared + 1, `${a2.alCleared} → ${a3.alCleared}`);
  check('  …and the subscription itself was still cached', (await prisma.groupBilling.findUnique({
    where: { group_id: ZZ }, select: { subscription_status: true } }))?.subscription_status === 'trialing',
    'the money write must not be lost to the reconciliation');

  // ── 5. AND ONLY A LIVE ONE ───────────────────────────────────────────────────────────────────
  // Without this, every check above is satisfied by a function that clears free_since unconditionally.
  console.log('\n— a subscription that is NOT live overtakes nothing —');
  await prisma.groupBilling.update({ where: { group_id: ZZ }, data: { subscription_status: null } });
  const setAgain = await F.setFree?.({ groupId: ZZ, reason: 'Gate fixture: proving a canceled status changes nothing', operatorUserId: OPERATOR_ID });
  check('the tenant is free again', setAgain?.ok === true, JSON.stringify(setAgain?.ok));
  const a4 = await countAudits();
  await C.applyStripeSubscriptionToCache?.(fakeSub('canceled'), ZZ);
  const afterCanceled = await freeOf();
  check('a canceled subscription leaves the decision standing', !!afterCanceled?.free_since, String(afterCanceled?.free_since));
  const a5 = await countAudits();
  check('  …and writes no audit row at all', a5.saCleared === a4.saCleared && a5.alCleared === a4.alCleared,
    `sa ${a4.saCleared}→${a5.saCleared}, al ${a4.alCleared}→${a5.alCleared} — a clear that did not happen must not be recorded`);

  // ── 6. A DEMO IS NEVER QUIETLY RECONCILED ────────────────────────────────────────────────────
  console.log('\n— and the other two flags are not its business —');
  await prisma.group.update({ where: { id: ZZ }, data: { is_internal: true } });
  await prisma.groupBilling.update({ where: { group_id: ZZ }, data: { subscription_status: null } });
  await C.applyStripeSubscriptionToCache?.(fakeSub('active'), ZZ);
  const afterInternal = await freeOf();
  check('is_internal survives a live subscription', afterInternal?.is_internal === true, String(afterInternal?.is_internal));
  check('is_demo survives it too', afterInternal?.is_demo === beforeGroup.is_demo, String(afterInternal?.is_demo));
  check('  …while free_since was still cleared', afterInternal?.free_since === null,
    'the three answer different questions; only one is overtaken by being charged');

  // ── 7. THE PORTAL LETS A FREE TENANT THROUGH ─────────────────────────────────────────────────
  console.log('\n— a free garage may still look at its own billing history —');
  await prisma.group.update({ where: { id: ZZ }, data: { is_internal: null } });
  await prisma.groupBilling.update({ where: { group_id: ZZ }, data: { subscription_status: null } });
  await F.setFree?.({ groupId: ZZ, reason: 'Gate fixture: proving the portal is reachable when free', operatorUserId: OPERATOR_ID });
  const portalRes = resSpy(), checkoutRes = resSpy();
  check('the portal does NOT refuse a free tenant',
    (await D.refuseDemoBilling?.(portalRes, ZZ, { allowFree: true })) === false, `${portalRes.code ?? 'no response written'}`);
  check('  …but checkout still does', (await D.refuseDemoBilling?.(checkoutRes, ZZ)) === true,
    `${checkoutRes.code} ${checkoutRes.body?.code}`);
  await prisma.group.update({ where: { id: ZZ }, data: { is_demo: true } });
  const demoPortal = resSpy();
  check('  …and the portal still refuses a DEMO', (await D.refuseDemoBilling?.(demoPortal, ZZ, { allowFree: true })) === true,
    `${demoPortal.code} ${demoPortal.body?.code} — allowFree is about free, not about everybody`);
  await prisma.group.update({ where: { id: ZZ }, data: { is_demo: beforeGroup.is_demo } });

  // ── 8. THE REFUSAL, OVER HTTP, WITH NO STRIPE KEY ────────────────────────────────────────────
  console.log('\n— and the refusal is reachable in an environment with no Stripe key —');
  const ready = await serverReady();
  check('the dev server serves pages before we drive it', ready.ok, `HTTP ${ready.status} after ${ready.attempts} attempt(s)`);
  browser = await chromium.launch({ channel: 'chrome' });
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
  await page.goto(`${BASE}/admin/login`, { waitUntil: 'domcontentloaded' });
  await page.fill('input[type="email"]', 'owner@zzgategarage.test');
  await page.fill('input[type="password"]', 'GateGarage!2026');
  await Promise.all([page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 60000 }), page.click('button[type="submit"]')]);
  // SIGNED IN, ASSERTED. A failed sign-in makes the POST below answer 401 from requireAdminApi,
  // which is neither the 403 we want nor the 503 we are ruling out — the check would fail with a
  // status that says nothing about the guard. It happened: regenerating the Prisma client mid-run
  // left the dev server holding a stale one and every login came back InvalidCredentials.
  check('the browser is actually signed in', !/\/admin\/login/.test(page.url()), page.url());
  const posted = await page.evaluate(async () => {
    const res = await fetch('/api/stripe/checkout', { method: 'POST' });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  });
  check('POST /api/stripe/checkout refuses a free tenant', posted.status === 403,
    `HTTP ${posted.status} ${JSON.stringify(posted.body).slice(0, 120)} — 503 means the guard is still behind getStripe()`);
  check('  …by name', posted.body?.code === 'free_tenant', String(posted.body?.code));
} catch (e) {
  check('gate run completed', false, describeError(e).slice(0, 300));
  await explainIfClientStale(BASE);
} finally {
  if (browser) await browser.close().catch(() => {});
  if (fix) {
    try {
      await prisma.group.update({ where: { id: ZZ }, data: {
        is_demo: fix.beforeGroup.is_demo, is_internal: fix.beforeGroup.is_internal,
        free_since: fix.beforeGroup.free_since, free_reason: fix.beforeGroup.free_reason,
        trial_ends_at: fix.beforeGroup.trial_ends_at } });
      if (fix.beforeBilling) {
        const { id, group_id, created_at, updated_at, ...cols } = fix.beforeBilling;
        await prisma.groupBilling.update({ where: { group_id: ZZ }, data: cols });
      }
      // FEATURE ROWS the cache writer upserts as a side effect: restore the ones that existed and
      // DELETE the ones it created, or ZZ silently gains a row per module per run.
      const keptKeys = fix.beforeFeatures.map((f) => f.feature_key);
      await prisma.groupFeature.deleteMany({ where: { group_id: ZZ, feature_key: { notIn: keptKeys.length ? keptKeys : ['__none__'] } } });
      for (const f of fix.beforeFeatures) {
        await prisma.groupFeature.updateMany({ where: { group_id: ZZ, feature_key: f.feature_key },
          data: { enabled: f.enabled, source: f.source } });
      }
    } catch (e) { console.log(`  teardown: ${describeError(e).slice(0, 120)}`); }
    const g = await prisma.group.findUnique({ where: { id: ZZ },
      select: { is_demo: true, is_internal: true, free_since: true, free_reason: true, trial_ends_at: true } });
    const b = await prisma.groupBilling.findUnique({ where: { group_id: ZZ } });
    const fts = await prisma.groupFeature.findMany({ where: { group_id: ZZ },
      select: { feature_key: true, enabled: true, source: true }, orderBy: { feature_key: 'asc' } });
    const norm = (o) => JSON.stringify(o);
    check('teardown restored every ZZ group flag', norm(g) === norm(fix.beforeGroup), `${norm(g)} vs ${norm(fix.beforeGroup)}`);
    check('teardown restored the whole billing row',
      norm({ ...b, updated_at: null }) === norm({ ...fix.beforeBilling, updated_at: null }),
      `${norm(b)} vs ${norm(fix.beforeBilling)}`);
    const sortFt = (a) => [...a].sort((x, y) => x.feature_key.localeCompare(y.feature_key));
    check('teardown restored the feature rows the cache writer touched',
      norm(sortFt(fts)) === norm(sortFt(fix.beforeFeatures)),
      `${fts.length} rows vs ${fix.beforeFeatures.length} before`);
  }
}

console.log(`\n${out.filter((x) => x === 'F').length} failures of ${out.length}`);
await prisma.$disconnect();
process.exit(out.includes('F') ? 1 : 0);
