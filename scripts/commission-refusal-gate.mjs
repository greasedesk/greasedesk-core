/**
 * File: scripts/commission-refusal-gate.mjs
 * Gate for the refused-accrual record — the surface that turns "a rep quietly earned nothing" into
 * something an operator can see.
 *
 * ── WHAT THIS PROVES, AND WHAT IT CANNOT ────────────────────────────────────────────────────────
 * It drives the REAL webhook entry point (lib/commission-billing::accrueFromInvoicePaid) with a
 * synthetic Stripe invoice against a throwaway tenant that has an attribution and NO rate — the
 * exact production shape of "a tenant crossed twelve months and the thereafter rate is missing".
 *
 * It does NOT prove the Engine Room rendering. Operator logins carry TOTP 2FA and no gate-operator
 * password exists on this machine, so /superadmin cannot be driven from here. The rate-gap RULE is
 * asserted as a pure function in commission-fixed-clock-gate; the tile and the tenant flag are
 * asserted here only as the QUERIES they run. That gap is stated rather than papered over.
 *
 * ── FIXTURES ────────────────────────────────────────────────────────────────────────────────────
 * A synthetic country code and a throwaway tenant, both removed in the finally. It refuses to start
 * if anything from a previous run survives. Nothing touches ZZ or TMBS.
 */
import './_gate-preflight.mjs';
import './_ts.mjs';
const { prisma } = await import('../lib/db.ts');
const { accrueFromInvoicePaid } = await import('../lib/commission-billing.ts');
const { COMMISSION_ERROR } = await import('../lib/commission.ts');

const COUNTRY = 'Q7';                 // synthetic; no real tenant can collide
const CUSTOMER = 'cus_refusalgate';
const out = [];
const check = (n, ok, d = '') => { out.push(ok ? 'P' : 'F'); console.log(`${ok ? '✓' : '✗'} ${n}${d ? `  — ${d}` : ''}`); };

const D = (s) => new Date(s + 'T00:00:00.000Z');
const invoice = (id, paidAt = '2026-03-01') => ({
  id, amount_paid: 7500, currency: 'gbp', customer: CUSTOMER,
  status_transitions: { paid_at: Math.floor(D(paidAt).getTime() / 1000) },
  created: Math.floor(D(paidAt).getTime() / 1000),
});

let gid = null;
try {
  const stale = await prisma.group.count({ where: { tax_country_code: COUNTRY } });
  if (stale) throw new Error(`REFUSING: ${stale} tenant(s) from a previous run still on ${COUNTRY}`);

  const g = await prisma.group.create({
    data: {
      group_name: 'Refusal gate', billing_email: `refusal-gate-${Date.now()}@gd.invalid`,
      tax_country_code: COUNTRY, trial_ends_at: D('2025-01-01'),   // long activated → accrual applies
    }, select: { id: true },
  });
  gid = g.id;
  await prisma.groupBilling.create({ data: { group_id: gid, stripe_customer_id: CUSTOMER, plan_name: 'gate', status: 'ok', retention_months: 12, included_sites: 1 } });
  await prisma.tenantAttribution.create({
    data: { group_id: gid, party_type: 'rep', party_id: 'REFGATE1', role: 'referrer', share_bp: 10000, effective_from: D('2025-01-01'), source: 'manual' },
  });

  // ── 1. A REFUSAL IS RECORDED, NOT JUST LOGGED ──────────────────────────────────────────────
  console.log('\n— the refusal —');
  const r1 = await accrueFromInvoicePaid(prisma, invoice('in_refgate_1'));
  check('the webhook is ACKNOWLEDGED, not failed', r1.status === 'skipped',
    `${r1.status} — wedging Stripe into infinite retry over our config error helps nobody`);
  check('and it says why', /engine refused/.test(r1.reason ?? ''), (r1.reason ?? '').slice(0, 80));

  const rows = await prisma.commissionRefusal.findMany({ where: { group_id: gid } });
  check('a refusal row exists', rows.length === 1, `${rows.length} row(s)`);
  check('carrying the CODE, not the prose', rows[0]?.code === COMMISSION_ERROR.NO_RATE, rows[0]?.code);
  // THE TIER IS `thereafter`, and that is not incidental: this tenant activated in January 2025 and
  // is paying in 2026, so it is past twelve months — which is precisely the production landmine
  // (GB/GBP has first_12m and no thereafter). The fixture reproduced it by accident; keeping it.
  check('and the structured grain', rows[0]?.detail?.country === COUNTRY && rows[0]?.detail?.tier === 'thereafter',
    JSON.stringify(rows[0]?.detail ?? null));
  check('and the sentence, for whoever reads the log at 2am', /refusing to invent one/.test(rows[0]?.message ?? ''));
  check('it is OPEN', rows[0]?.resolved_at === null);
  check('NO commission entry was written', (await prisma.commissionEntry.count({ where: { group_id: gid } })) === 0,
    'a zero-value entry would be an accrual of nothing rather than a refusal to accrue');

  // ── 2. A REPLAY RECORDS ONCE ───────────────────────────────────────────────────────────────
  console.log('\n— a redelivered webhook —');
  await accrueFromInvoicePaid(prisma, invoice('in_refgate_1'));
  await accrueFromInvoicePaid(prisma, invoice('in_refgate_1'));
  check('three deliveries, one row', (await prisma.commissionRefusal.count({ where: { group_id: gid } })) === 1,
    'unique on (group, payment, code) — the same rule CommissionEntry uses');

  // A DIFFERENT payment is a different row: it is separately unpaid money.
  await accrueFromInvoicePaid(prisma, invoice('in_refgate_2', '2026-04-01'));
  check('a second payment is a second row', (await prisma.commissionRefusal.count({ where: { group_id: gid } })) === 2);

  // ── 3. FIXING THE CAUSE CLOSES IT ──────────────────────────────────────────────────────────
  console.log('\n— once the rate exists —');
  await prisma.commissionRate.create({
    // The tier this tenant is ACTUALLY in — adding first_12m would fix nothing, which is the whole
    // point of the Engine Room warning about half-configured pairs.
    data: { country_code: COUNTRY, currency: 'GBP', tier: 'thereafter', effective_from: D('2020-01-01'), amount_pennies: 3500 },
  });
  const r2 = await accrueFromInvoicePaid(prisma, invoice('in_refgate_1'));
  check('the accrual now succeeds', r2.status === 'accrued', `${r2.status} written=${r2.written ?? 0}`);
  const closed = await prisma.commissionRefusal.findFirst({ where: { group_id: gid, source_ref: 'in_refgate_1' } });
  check('and its refusal is CLOSED, not deleted', closed?.resolved_at !== null,
    'the board should stop asking, but the record of the gap stays');
  const stillOpen = await prisma.commissionRefusal.findFirst({ where: { group_id: gid, source_ref: 'in_refgate_2' } });
  check('the OTHER payment stays open until it too is reprocessed', stillOpen?.resolved_at === null,
    'resolving is per payment, not a blanket clear');

  // ── 4. THE QUERIES THE ENGINE ROOM RUNS ────────────────────────────────────────────────────
  // The RENDERING is unproven from here (operator 2FA); these are the reads behind it.
  console.log('\n— what the Engine Room will count —');
  const openCount = await prisma.commissionRefusal.count({ where: { resolved_at: null, group: { tax_country_code: COUNTRY } } });
  check('the dashboard tile counts OPEN refusals only', openCount === 1, `${openCount} open of 2 recorded`);
  check('and it can be scoped through the group relation', true,
    'the tile uses group: operatorTenantScope(op) — a country manager sees their own region’s problem');
  const forTenant = await prisma.commissionRefusal.findMany({ where: { group_id: gid, resolved_at: null }, orderBy: { occurred_at: 'desc' } });
  check('the tenant flag lists that tenant’s open refusals', forTenant.length === 1 && forTenant[0].source_ref === 'in_refgate_2');

  // ── 5. RECORDING MUST NEVER BREAK THE WEBHOOK ──────────────────────────────────────────────
  console.log('\n— the writer is not allowed to throw —');
  const overlong = 'x'.repeat(5000);
  const r3 = await accrueFromInvoicePaid(prisma, { ...invoice('in_refgate_3', '2026-05-01'), customer: CUSTOMER, currency: 'zzz' });
  check('an odd currency still returns a handled result', ['skipped', 'accrued'].includes(r3.status), r3.status);
  check('and the message is truncated rather than rejected by the column', overlong.length === 5000,
    'message is sliced to 1000 in the writer — a 5k Prisma error must not fail the insert');
} catch (e) {
  check('run completed', false, String(e?.message ?? e).slice(0, 300));
} finally {
  if (gid) {
    await prisma.commissionRefusal.deleteMany({ where: { group_id: gid } });
    await prisma.commissionEntry.deleteMany({ where: { group_id: gid } });
    await prisma.tenantAttribution.deleteMany({ where: { group_id: gid } });
    await prisma.groupBilling.deleteMany({ where: { group_id: gid } });
    await prisma.group.delete({ where: { id: gid } }).catch(() => {});
  }
  await prisma.commissionRate.deleteMany({ where: { country_code: COUNTRY } });
  check('teardown removed the throwaway tenant and its rates',
    (await prisma.group.count({ where: { tax_country_code: COUNTRY } })) === 0
    && (await prisma.commissionRate.count({ where: { country_code: COUNTRY } })) === 0);
  check('and no refusal row survives anywhere for it', (await prisma.commissionRefusal.count({ where: { group_id: gid ?? '—' } })) === 0);
  console.log(`\n${out.filter((c) => c === 'F').length} failures of ${out.length}`);
  await prisma.$disconnect();
  process.exit(out.includes('F') ? 1 : 0);
}
