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
const G = 'f3542807-2729-4bc3-8158-9bf7b9d0b353';
const g = await prisma.group.findUnique({ where: { id: G }, select: { ref: true, is_demo: true, is_internal: true } });
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

console.log(`\n${out.filter((c) => c === 'F').length} failures of ${out.length}`);
await prisma.$disconnect();
process.exit(out.includes('F') ? 1 : 0);
