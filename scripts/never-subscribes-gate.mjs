/**
 * File: scripts/never-subscribes-gate.mjs
 * ONE FLAG, TWO JOBS — and the readers that were still asking the wrong one.
 *
 * `is_demo` means "never send messages from here". `is_internal` means "this is ours". They were a
 * single flag until 2026-08-18, when the sales demo needed to send real texts and became
 * is_demo = false. Every reader using is_demo to mean "internal" silently changed its mind.
 *
 * TWO were found by the tenant looking broken, a day apart: the onboarding gate locked the demo
 * behind /onboarding/phone, and the setup nag stuck at "7 of 8 done" with `subscription`
 * outstanding forever. Neither had a gate. This is that gate.
 */
import './_gate-preflight.mjs';
import './_ts.mjs';
const { prisma } = await import('../lib/db.ts');
const { neverSubscribes } = await import('../lib/demo-tenant.ts');
const { getSetupSignals } = await import('../lib/setup-signals.ts');
const { readFileSync } = await import('node:fs');
const { refuseDemoBilling, isDemoGroup } = await import('../lib/demo-tenant.ts');
const { refuseDemoMaintenance } = await import('../lib/demo-tenants.ts');

const out = [];
const check = (n, ok, d = '') => { out.push(ok ? 'P' : 'F'); console.log(`${ok ? '✓' : '✗'} ${n}${d ? `  — ${d}` : ''}`); };

// ── 1. THE PREDICATE ─────────────────────────────────────────────────────────────────────────────
console.log('\n— an internal tenant never buys a subscription, however it is internal —');
check('a demo that cannot send is internal', neverSubscribes({ is_demo: true, is_internal: false }) === true);
check('a demo that CAN send is still internal', neverSubscribes({ is_demo: false, is_internal: true }) === true,
  'the case that broke: is_demo false so it can text, is_internal true because it is ours');
check('both flags', neverSubscribes({ is_demo: true, is_internal: true }) === true);
check('a real tenant is NOT', neverSubscribes({ is_demo: false, is_internal: false }) === false);
check('null is NOT — absence never grants the exemption', neverSubscribes(null) === false);
check('undefined columns are NOT', neverSubscribes({}) === false);

// ── 2. ON THE TENANT THAT BROKE ──────────────────────────────────────────────────────────────────
console.log('\n— the sales demo, which has no GroupBilling row and never will —');
// BY REF, NEVER A PINNED ID. This held Kingsford's group id, and a refresh REPLACES the tenant
// rather than emptying it — so the id changed the moment the demo was regenerated and every query
// below resolved to null, crashing the gate three checks in. The ref is what a refresh preserves;
// it is the same correction DEMO_TENANTS took, found here by the gate rather than by the grep that
// went looking for stale seeds and did not think to look for stale ids.
const DEMO_REF = 'GB-GD2369';
const g = await prisma.group.findFirst({ where: { ref: DEMO_REF }, select: { id: true, ref: true, is_demo: true, is_internal: true } });
if (!g) { console.log(`✗ ${DEMO_REF} not found — the sales demo is missing, not merely renumbered`); process.exit(1); }
const G = g.id;
const billing = await prisma.groupBilling.findUnique({ where: { group_id: G }, select: { subscription_status: true } });
check(`${g?.ref} is is_demo=false, is_internal=true`, g?.is_demo === false && g?.is_internal === true);
check('and genuinely has NO GroupBilling row', billing === null,
  'so the signal cannot be satisfied by a status — only by the tenant being ours');

const site = await prisma.site.findFirst({ where: { group_id: G }, select: { id: true } });
const sum = await getSetupSignals(G, site?.id ?? null);
const sub = sum.signals.find((s) => s.key === 'subscription');
check('the subscription signal reads DONE', sub?.state === 'done', sub?.state);
check('and nothing is outstanding — the nag clears', sum.outstanding.length === 0,
  `${sum.doneCount} of ${sum.applicableCount}; outstanding: ${sum.outstanding.map((o) => o.key).join(', ') || 'none'}`);

// ── 3. PROVE RED ─────────────────────────────────────────────────────────────────────────────────
console.log('\n— the gate can fail: the old expression against the same tenant —');
const SUBSCRIBED = new Set(['trialing', 'active']);
const oldState = (g.is_demo || SUBSCRIBED.has(billing?.subscription_status ?? '')) ? 'done' : 'todo';
check('the OLD rule (is_demo alone) leaves it TODO', oldState === 'todo',
  'which is exactly the "7 of 8 done" the owner reported, forever');

// ── 4. A PAYING TENANT IS UNAFFECTED ─────────────────────────────────────────────────────────────
console.log('\n— the exemption does not leak to a customer —');
const real = await prisma.group.findFirst({
  where: { is_demo: false, OR: [{ is_internal: null }, { is_internal: false }] },
  select: { id: true, ref: true },
});
if (real) {
  check(`${real.ref} does NOT get the exemption`, neverSubscribes(await prisma.group.findUnique({
    where: { id: real.id }, select: { is_demo: true, is_internal: true },
  })) === false, 'its subscription signal must still depend on a real Stripe status');
} else check('a non-internal tenant exists to test against', false, 'none found — the check above is vacuous');

// ── 5. THE READER USES THE NAMED QUESTION ────────────────────────────────────────────────────────
console.log('\n— asked by name, not by flag —');
const src = readFileSync('lib/setup-signals.ts', 'utf8');
check('setup-signals calls neverSubscribes', /neverSubscribes\(group\)/.test(src));
const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
check('and no longer tests group.is_demo directly', !/group\?\.is_demo/.test(code));
check('  …with the reason kept for the next reader', /is_demo = false\s*\n?\s*\/\/ so it could text|so it could text/.test(src));

// ── 6. THE THIRD READER: A REP MUST NOT REACH A REAL STRIPE CHECKOUT ────────────────────────────
console.log('\n— the billing refusal asks the same question —');
const fakeRes = () => { const r = { code: null, body: null }; r.status = (c) => { r.code = c; return { json: (b) => { r.body = b; return b; } }; }; return r; };
const demoRes = fakeRes();
check('refuseDemoBilling REFUSES the sales demo', (await refuseDemoBilling(demoRes, G)) === true,
  `${demoRes.code} ${demoRes.body?.code ?? ''}`);
// PROVE RED: the predicate it used to call still says "not a demo" for this tenant.
check('the OLD predicate (isDemoGroup) would have LET IT THROUGH', (await isDemoGroup(G)) === false,
  'is_demo is false so it can text — which is exactly why the billing refusal was open');
if (real) {
  const realRes = fakeRes();
  check(`and it does NOT refuse ${real.ref}`, (await refuseDemoBilling(realRes, real.id)) === false,
    'a paying tenant must still be able to reach checkout');
}

// ── 7. MAINTENANCE TARGETING: THE FROZEN REFERENCE IS EXCLUDED BY THE LIST ──────────────────────
console.log('\n— a maintenance script writes only to a declared, still-internal demo —');
const frozen = await prisma.group.findFirst({ where: { ref: 'GB-GD2236' }, select: { id: true, ref: true, is_internal: true, is_demo: true } });
check('the frozen reference demo is REFUSED', refuseDemoMaintenance(frozen.ref, frozen)?.code === 'not_listed',
  'not by an id check — it is simply absent from DEMO_TENANTS, so "listed" already excludes it');
check('the declared sales demo is ALLOWED', refuseDemoMaintenance(g.ref, { ref: g.ref, is_internal: true, is_demo: false }) === null);
check('a declared demo that stopped being internal is REFUSED',
  refuseDemoMaintenance(g.ref, { ref: g.ref, is_internal: false, is_demo: false })?.code === 'not_internal',
  'the list is a claim; is_internal is the fact, checked at the moment of use');

// ── 8. THE LEDGER THE BACKFILL WROTE ───────────────────────────────────────────────────────────
console.log('\n— and the tenant now has a ledger —');
const payCount = await prisma.payment.count({ where: { invoice: { group_id: G } } });
const paidInv = await prisma.invoice.count({ where: { group_id: G, status: 'paid', series: 'chargeable' } });
check('every paid chargeable invoice has a Payment row', payCount === paidInv, `${payCount} rows for ${paidInv} invoices`);
const orphan = await prisma.invoice.count({ where: { group_id: G, status: 'paid', series: 'chargeable', payments: { none: {} } } });
check('no paid invoice is left without one', orphan === 0, `${orphan} orphans`);

console.log(`\n${out.filter((c) => c === 'F').length} failures of ${out.length}`);
await prisma.$disconnect();
process.exit(out.includes('F') ? 1 : 0);
