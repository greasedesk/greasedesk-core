/**
 * File: pages/api/superadmin/affiliates.ts
 * SUSPEND AND UNSUSPEND AN AFFILIATE. POST { affiliateId, suspended }.
 *
 * OWNER ONLY, re-enforced here and not merely by the screen: the nav hides the page from everyone
 * else and the page 404s them, but an endpoint is reachable by anybody who can post. Support and a
 * country manager get the same 404 the page gives them — not a 403, which would confirm it exists.
 *
 * ── THE RULE LIVES IN lib/affiliate-admin, NOT HERE ────────────────────────────────────────────
 * setSuspended owns what suspension means and is idempotent on the DATE, which matters: "earns
 * nothing from that moment" would otherwise mean "from the last time anybody clicked". This file
 * authenticates, audits and answers.
 *
 * ── AND IT IS AUDITED, because it stops somebody's income ──────────────────────────────────────
 * One SuperAdminAudit row per actual change, naming the affiliate and the direction. A click that
 * changed nothing (suspending a suspended affiliate) writes no row, for the reason the plan-settings
 * writer gives: an audit row per form submission rather than per change fills the log with "nothing
 * happened" and buries the entries that matter.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { prisma } from '@/lib/db';
import { requireOperatorApi } from '@/lib/operator-auth';
import { listAffiliates, setSuspended } from '@/lib/affiliate-admin';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const actor = await requireOperatorApi(req, res);
  if (!actor) return;
  if (actor.role !== 'owner') { res.status(404).json({ message: 'Not found.' }); return; }

  if (req.method === 'GET') {
    // Present so the screen can refresh itself after a change without a full page load. The page's
    // own getServerSideProps is still the first read — this is the same list, from the same reader.
    return res.status(200).json({ ok: true, affiliates: await listAffiliates(prisma) });
  }

  if (req.method !== 'POST') { res.setHeader('Allow', 'GET, POST'); return res.status(405).json({ ok: false, message: 'Method Not Allowed' }); }

  const affiliateId = String((req.body || {}).affiliateId ?? '');
  const suspended = (req.body || {}).suspended;
  if (!affiliateId || typeof suspended !== 'boolean') {
    // A BOOLEAN, CHECKED AS ONE. `Boolean(req.body.suspended)` would turn the string "false" into
    // true and unsuspend nobody while reporting success.
    return res.status(400).json({ ok: false, message: 'Say which affiliate, and whether to suspend or unsuspend.' });
  }

  const before = await prisma.rep.findUnique({ where: { id: affiliateId }, select: { suspended_at: true, name: true, ref_code: true } });
  const r = await setSuspended(prisma, { affiliateId, suspended });
  if (!r.ok) return res.status(400).json({ ok: false, message: r.message });

  const changed = (!!before?.suspended_at) !== (!!r.suspendedAt);
  if (changed) {
    await prisma.superAdminAudit.create({
      data: {
        operator_user_id: actor.userId,
        action: 'affiliate_suspension',
        target_group_id: null, target_operator_id: null,
        target_name_snapshot: `${before?.name ?? 'affiliate'} (${before?.ref_code ?? affiliateId})`,
        target_ref_snapshot: suspended
          ? `suspended — earns nothing from ${r.suspendedAt?.toISOString().slice(0, 10)}`
          : 'unsuspended — may earn again, and may take new referrals',
        detail: { affiliate_id: affiliateId, suspended },
      },
    }).catch((e) => {
      // THE SUSPENSION STANDS. A failed audit write is a record lost, not a reason to leave
      // somebody earning after an operator stopped them — and it is logged loudly rather than
      // swallowed, because an unexplained suspension is the thing somebody will have to explain.
      console.error('[superadmin/affiliates] suspension applied but NOT audited for', affiliateId, e);
    });
  }

  return res.status(200).json({
    ok: true, suspendedAt: r.suspendedAt, changed,
    affiliates: await listAffiliates(prisma),
  });
}
