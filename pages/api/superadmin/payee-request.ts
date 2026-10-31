/**
 * File: pages/api/superadmin/payee-request.ts
 * APPLY, REJECT OR REVEAL A PAYEE. POST { action, requestId | affiliateId, reason? }.
 *
 * OWNER ONLY, re-enforced here and not merely by the screen — the same reasoning as
 * superadmin/affiliates.ts: the nav hides the page and the page 404s, but an endpoint is reachable
 * by anyone who can post. Support and a country manager get the 404, never a 403, which would
 * confirm the endpoint exists.
 *
 * ── THE THREE ACTIONS ARE NOT EQUALLY DANGEROUS, AND THE FILE SAYS SO ───────────────────────────
 *   apply   — copies ciphertext across without opening it. No key, no digits, no reveal.
 *   reject  — needs a reason.
 *   reveal  — produces the digits, and REFUSES if its audit row cannot be written.
 *
 * The rules all live in lib/payee-admin; this file authenticates, routes and answers.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { prisma } from '@/lib/db';
import { requireOperatorApi } from '@/lib/operator-auth';
import { applyPayeeRequest, rejectPayeeRequest, revealPayee, listPayeeRequests } from '@/lib/payee-admin';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const actor = await requireOperatorApi(req, res);
  if (!actor) return;
  // OWNER, AND THE COMPARISON IS EXPLICIT rather than roleAtLeast: there is no role above owner, so
  // a floor and an equality are the same test today — and if one is ever added, this must be
  // reconsidered deliberately rather than inheriting a new actor silently.
  if (actor.role !== 'owner') { res.status(404).json({ message: 'Not found.' }); return; }

  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).end(); }

  const action = String(req.body?.action ?? '');

  if (action === 'reveal') {
    const affiliateId = String(req.body?.affiliateId ?? '');
    if (!affiliateId) return res.status(400).json({ message: 'Which affiliate?' });
    const r = await revealPayee(prisma as any, { repId: affiliateId, operatorUserId: actor.userId });
    if (!r.ok) return res.status(r.code === 'not_found' ? 404 : 409).json({ message: r.message });
    return res.status(200).json({ ok: true, value: r.value });
  }

  const requestId = String(req.body?.requestId ?? '');
  if (!requestId) return res.status(400).json({ message: 'Which request?' });

  if (action === 'apply') {
    const r = await applyPayeeRequest(prisma as any, { requestId, operatorUserId: actor.userId });
    if (!r.ok) return res.status(r.code === 'not_found' ? 404 : 409).json({ message: r.message });
    return res.status(200).json({ ok: true, requests: await shaped() });
  }

  if (action === 'reject') {
    const r = await rejectPayeeRequest(prisma as any, {
      requestId, operatorUserId: actor.userId, reason: String(req.body?.reason ?? ''),
    });
    if (!r.ok) return res.status(r.code === 'not_found' ? 404 : r.code === 'no_reason' ? 400 : 409).json({ message: r.message });
    return res.status(200).json({ ok: true, requests: await shaped() });
  }

  return res.status(400).json({ message: 'Unknown action.' });
}

/** Dates as strings, field by field — the screen is handed exactly what the page's props hold. */
async function shaped() {
  const rows = await listPayeeRequests(prisma as any);
  return rows.map((r) => ({ ...r, requestedAt: r.requestedAt.toISOString() }));
}
