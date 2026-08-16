/**
 * File: pages/api/billing-gate.ts
 * GET → the tenant's billing phase, for the shell banner. Tiny by design: the admin shell is mounted
 * once for every /admin page, so this is fetched once per session, not per navigation. Putting it in
 * _app's getInitialProps instead would add a query to every route change.
 *
 * Reads the SAME resolver every API guard reads (lib/billing.billingGate) — the banner cannot
 * disagree with the gate that produced the 402 a user is looking at.
 *
 * No admin requirement: every signed-in user of the tenant sees the shell, and a STANDARD user
 * being told the garage's payment hasn't arrived is better than them hitting an unexplained refusal.
 * It returns no money, no card details and no Stripe ids.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { requireTenantApi } from '@/lib/admin-guard';
import { prisma } from '@/lib/db';
import { billingGate, gateFromRow, BILLING_GATE_SELECT } from '@/lib/billing';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') { res.setHeader('Allow', 'GET'); return res.status(405).end(); }
  const scope = await requireTenantApi(req, res);
  if (!scope) return;

  const row = await prisma.groupBilling.findUnique({
    where: { group_id: scope.groupId }, select: BILLING_GATE_SELECT,
  });
  const g = billingGate(gateFromRow(row as any));
  return res.status(200).json({
    phase: g.phase,
    daysLeft: g.daysLeft,
    graceEndsAt: g.graceEndsAt ? g.graceEndsAt.toISOString() : null,
    reason: g.reason,
  });
}
