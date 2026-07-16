/**
 * File: pages/api/cron/setup-proof.ts  — TEMPORARY (item-13 setup-panel acceptance). DELETE after.
 * CRON_SECRET-guarded. Proves the 8-signal three-state DERIVED model on a throwaway ZZ tenant:
 * every "done" flips from a real row/value; the two NA-capable signals go todo→not_applicable→done
 * (done takes precedence over an NA declaration); and there is NO setup_step_completed column.
 * Purges the ZZ tenant at the end. TMBS untouched.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import crypto from 'crypto';
import { prisma } from '@/lib/db';
import { Prisma } from '@prisma/client';
import { getSetupSignals } from '@/lib/setup-signals';
import { purgeTenant } from '@/lib/tenant-purge';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.authorization !== `Bearer ${secret}`) return res.status(401).json({ message: 'Unauthorized.' });

  const checks: any[] = [];
  const state = async (key: string) => (await getSetupSignals(groupId!, siteId)).signals.find((s) => s.key === key)?.state;
  const record = async (label: string, key: string, expect: string) => {
    const got = await state(key);
    checks.push({ label, key, expect, got, pass: got === expect });
  };

  let groupId: string | null = null;
  let siteId: string | null = null;
  try {
    const stamp = crypto.randomUUID().slice(0, 8);
    const email = `zz-setup-${stamp}@example.com`;

    // Fully onboarded tenant (so the 4 gated signals are done): group + owner + site + labour + tax + sub cache.
    const group = await prisma.group.create({ data: { group_name: 'ZZ Setup Proof', billing_email: email, status: 'trial', tax_default_rate_bp: 2000 } });
    groupId = group.id;
    const owner = await prisma.user.create({ data: { name: 'ZZ Owner', email, passwordHash: 'x', role: 'ADMIN', is_owner: true, group_id: group.id, is_active: true, emailVerified: new Date() } });
    const site = await prisma.site.create({ data: { group_id: group.id, site_name: 'ZZ Workshop', timezone: 'Europe/London', currency_code: 'GBP', locale: 'en-GB', users: { connect: { id: owner.id } } } });
    siteId = site.id;
    await prisma.serviceCatalogue.create({ data: { group_id: group.id, site_id: site.id, service_code: 'LABOUR_HR', name: 'Labour', default_labour_rate: new Prisma.Decimal('90.00'), default_price: new Prisma.Decimal('90.00'), vat_rate: new Prisma.Decimal('20.00'), is_active: true } });
    await prisma.groupBilling.create({ data: { group_id: group.id, plan_name: 'TRIAL', status: 'ok', retention_months: 12, included_sites: 1, active_sites_cnt: 1, subscription_status: 'trialing' } });

    // Initial: gated done; optional todo.
    for (const k of ['location', 'labour_rate', 'tax', 'subscription']) await record(`gated ${k} done`, k, 'done');
    await record('resources todo', 'resources', 'todo');
    await record('employees todo', 'employees', 'todo');
    await record('company_number todo', 'company_number', 'todo');
    await record('overheads todo', 'overheads', 'todo');

    // NA declarations (the ONLY stored applicability bits) → not_applicable.
    await prisma.group.update({ where: { id: group.id }, data: { employees_not_applicable: true } });
    await record('employees → not_applicable (declared)', 'employees', 'not_applicable');
    await prisma.group.update({ where: { id: group.id }, data: { company_number_not_applicable: true } });
    await record('company_number → not_applicable (declared)', 'company_number', 'not_applicable');

    // Derived done from real rows.
    await prisma.resource.create({ data: { site_id: site.id, name: 'Lift 1', type: 'lift' } });
    await record('resources → done (row exists)', 'resources', 'done');
    await prisma.overhead.create({ data: { group_id: group.id, name: 'Rent', ex_vat_amount_pennies: 100000, period: 'monthly' } });
    await record('overheads → done (row exists)', 'overheads', 'done');

    // DONE takes precedence over an NA declaration (a real row beats "not applicable").
    await prisma.costPerson.create({ data: { group_id: group.id, name: 'Alex', amount_pennies: 3000000, cost_type: 'salary' } });
    await record('employees → done overrides NA', 'employees', 'done');
    await prisma.group.update({ where: { id: group.id }, data: { company_number: 'GB123456789' } });
    await record('company_number → done overrides NA', 'company_number', 'done');

    const summary = await getSetupSignals(group.id, site.id);

    // No stored "done" flag anywhere on Group.
    const cols = (await prisma.$queryRawUnsafe(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'Group' AND (column_name ILIKE '%setup%step%' OR column_name ILIKE '%step_completed%' OR column_name ILIKE '%_done')`,
    )) as Array<{ column_name: string }>;

    const op = await prisma.platformOperator.findFirst({ select: { user_id: true } });
    const purge = await purgeTenant(op?.user_id ?? owner.id, group.id);
    groupId = null;

    return res.status(200).json({
      ok: checks.every((c) => c.pass) && cols.length === 0 && summary.allDone,
      allChecksPass: checks.every((c) => c.pass),
      checks,
      finalAllDone: summary.allDone,
      doneCount: summary.doneCount,
      applicableCount: summary.applicableCount,
      doneFlagColumnsFound: cols.map((c) => c.column_name),
      purged: purge.after ? Object.values(purge.after).every((n) => n === 0) : null,
    });
  } catch (e: any) {
    if (groupId) { try { const op = await prisma.platformOperator.findFirst({ select: { user_id: true } }); await purgeTenant(op?.user_id ?? '00000000-0000-0000-0000-000000000000', groupId); } catch {} }
    console.error('[setup-proof] failed', e?.message);
    return res.status(500).json({ ok: false, error: e?.message, checks });
  }
}
