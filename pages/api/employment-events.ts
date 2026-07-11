/**
 * File: pages/api/employment-events.ts
 * GET the effective-dated employment history (ADMIN only — wages are in here).
 *   ?personId=…  → that person's full event log (History tab)
 *   (none)       → the group-level change list, newest first (Changes tab), capped.
 * Events are append-only; there is no write here — the ONLY writers are the dual-write
 * transactions in /api/headcount and /api/roster (lib/employment-events).
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import { requireAdminApi } from '@/lib/admin-guard';
import { redateEvent, voidEvent, datedConfirmNeeded } from '@/lib/employment-events';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const vis = await requireAdminApi(req, res);
  if (!vis) return;
  if (!vis.groupId) return res.status(400).json({ message: 'No tenant context.' });
  // ---- PATCH: admin-only corrections — the correction is ITSELF recorded on the row ----
  if (req.method === 'PATCH') {
    const { id, action, effectiveDate, confirmDated } = (req.body || {}) as any;
    if (!id) return res.status(400).json({ message: 'Missing event id.' });
    if (action === 'redate') {
      const ds = String(effectiveDate || '').trim();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(ds)) return res.status(400).json({ message: 'Enter a valid effective date.' });
      const d = new Date(`${ds}T00:00:00.000Z`);
      const today = new Date(`${new Date().toISOString().slice(0, 10)}T00:00:00.000Z`);
      if (datedConfirmNeeded(d, today) && !confirmDated) {
        return res.status(409).json({ needsDateConfirm: true, message: 'That effective date is more than a year away — confirm it’s intended.' });
      }
      const r = await prisma.$transaction((tx: Prisma.TransactionClient) => redateEvent(tx, { groupId: vis.groupId!, eventId: id, newEffectiveDate: d, by: vis.userId ?? null }));
      if (!r.ok) return res.status(r.error === 'notFound' ? 404 : 409).json({ message: r.error === 'voided' ? 'That entry is voided — it can’t be re-dated.' : r.error === 'unchanged' ? 'That’s already the effective date.' : 'Event not found.' });
      return res.status(200).json({ message: 'Effective date corrected.' });
    }
    if (action === 'void') {
      const r = await prisma.$transaction((tx: Prisma.TransactionClient) => voidEvent(tx, { groupId: vis.groupId!, eventId: id, by: vis.userId ?? null }));
      if (!r.ok) return res.status(r.error === 'notFound' ? 404 : 409).json({ message: r.error === 'voided' ? 'That entry is already voided.' : 'Event not found.' });
      return res.status(200).json({ message: 'Entry voided — it stays visible but no longer counts.' });
    }
    return res.status(400).json({ message: 'Unknown action.' });
  }

  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET, PATCH');
    return res.status(405).json({ message: 'Method Not Allowed' });
  }
  const personId = req.query.personId ? String(req.query.personId) : null;
  const rows = (await prisma.employmentEvent.findMany({
    where: { group_id: vis.groupId, ...(personId ? { cost_person_id: personId } : {}) },
    orderBy: [{ created_at: 'desc' }],
    take: personId ? 200 : 300,
    select: {
      id: true, cost_person_id: true, kind: true, effective_date: true,
      value_json: true, previous_json: true, changed_by: true, created_at: true,
      correction_json: true, voided_at: true, voided_by: true,
      cost_person: { select: { name: true } },
    },
  })) as any[];
  // Resolve the changer names in one pass (changed_by is a user id).
  const userIds = [...new Set(rows.map((r) => r.changed_by).filter(Boolean))] as string[];
  const users = userIds.length
    ? ((await prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true, email: true } })) as any[])
    : [];
  const nameOf = new Map(users.map((u) => [u.id, u.name || u.email]));
  return res.status(200).json({
    events: rows.map((r) => ({
      id: r.id,
      personId: r.cost_person_id,
      personName: r.cost_person?.name ?? '—',
      kind: r.kind,
      effectiveDate: r.effective_date.toISOString().slice(0, 10),
      value: r.value_json,
      previous: r.previous_json,
      changedBy: r.changed_by ? (nameOf.get(r.changed_by) ?? '—') : null,
      at: r.created_at.toISOString(),
      corrections: Array.isArray(r.correction_json) ? r.correction_json : [],
      voided: !!r.voided_at,
    })),
  });
}
