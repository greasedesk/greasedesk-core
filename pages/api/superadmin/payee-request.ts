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
 *   apply        — copies ciphertext across without opening it. No key, no digits, no reveal.
 *   reject       — needs a reason.
 *   correct_name — the account NAME only, on a pending request or on what we hold. It cannot reach
 *                  the digits: lib/payee-admin names one column, and no sort code or account number
 *                  is in its argument. Audited with both values, and the affiliate is told.
 *   reveal       — produces the digits, and REFUSES if its audit row cannot be written.
 *
 * The rules all live in lib/payee-admin; this file authenticates, routes and answers.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { prisma } from '@/lib/db';
import { requireOperatorApi } from '@/lib/operator-auth';
import {
  applyPayeeRequest, rejectPayeeRequest, revealPayee, listPayeeRequests, correctPayeeName,
} from '@/lib/payee-admin';

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

  /**
   * CORRECT A NAME. Handled before the requestId guard below, because this action takes EITHER a
   * requestId (a pending request) or an affiliateId (what we hold) — the subject is declared, not
   * inferred from which field happens to be present.
   */
  if (action === 'correct_name') {
    const newName = String(req.body?.newName ?? '');
    const forRequest = String(req.body?.requestId ?? '');
    const forAffiliate = String(req.body?.affiliateId ?? '');
    if (!forRequest && !forAffiliate) return res.status(400).json({ message: 'Whose name?' });
    if (forRequest && forAffiliate) {
      // BOTH IS A CALLER THAT HAS NOT DECIDED, and guessing would correct the wrong row.
      return res.status(400).json({ message: 'Name one subject: a request, or the details we hold.' });
    }
    const r = await correctPayeeName(prisma as any, {
      subject: forRequest ? { kind: 'request', requestId: forRequest } : { kind: 'held', repId: forAffiliate },
      newName,
      operatorUserId: actor.userId,
    });
    if (!r.ok) return res.status(r.code === 'not_found' ? 404 : r.code === 'bad_name' ? 400 : 409).json({ message: r.message });
    /**
     * THE SEND'S OUTCOME TRAVELS WITH THE SUCCESS. The correction is done either way; whether the
     * affiliate was TOLD is a separate fact and the screen prints it, because an affiliate who was
     * not told is the case that needs a phone call.
     */
    return res.status(200).json({
      ok: true, emailed: r.emailed ?? 'not_sent', emailNote: r.emailNote ?? null, requests: await shaped(),
    });
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
