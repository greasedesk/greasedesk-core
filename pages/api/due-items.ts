/**
 * File: pages/api/due-items.ts
 * Record a finding against the CAR, and close one.
 *   POST  { jobCardId, description, dueBasis, dueDate?, dueMileage?, customerResponse }
 *   PATCH { id, closedReason? }   → close it
 *
 * OPERATIONAL authority (canAccessSite): the mechanic at the car is the person who finds these,
 * and a finding nobody may record is a finding that stays in their head — which is the failure
 * this exists to fix.
 *
 * The vehicle comes from the CARD, never the client: a caller must not be able to attach a finding
 * to a car it never saw. Every refusal comes from lib/due-items::refuseDueItem — the same pure
 * predicate the gate proves — so the API cannot be laxer than the rule.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/pages/api/auth/[...nextauth]';
import { getVisibility } from '@/lib/site-visibility';
import { canAccessSite } from '@/lib/admin-guard';
import { writeAudit } from '@/lib/audit';
import { refuseDueItem, responseAtFor, openDueItemsForVehicle, type DueBasis, type DueItemResponse } from '@/lib/due-items';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST' && req.method !== 'PATCH' && req.method !== 'GET') {
    res.setHeader('Allow', 'GET, POST, PATCH');
    return res.status(405).json({ message: 'Method Not Allowed' });
  }
  const session = await getServerSession(req, res, authOptions);
  const user = session?.user as any;
  if (!user?.id || !user?.group_id) return res.status(401).json({ message: 'Not authenticated.' });
  const groupId = user.group_id as string;

  // ── LIST (open items for the card's CAR) ──────────────────────────────────────────────────────
  if (req.method === 'GET') {
    const jobCardId = String(req.query.jobCardId ?? '');
    if (!jobCardId) return res.status(400).json({ message: 'jobCardId is required.' });
    const c = await prisma.jobCard.findFirst({ where: { id: jobCardId, group_id: groupId }, select: { site_id: true, vehicle_id: true } });
    if (!c) return res.status(404).json({ message: 'Job card not found.' });
    const v = await getVisibility(user.id as string);
    if (!canAccessSite(v, c.site_id)) return res.status(403).json({ message: 'You do not have access to this job card’s location.' });
    // THE SAME chokepoint the page render uses, so the panel and the server cannot disagree.
    return res.status(200).json({ items: await openDueItemsForVehicle(prisma, groupId, c.vehicle_id) });
  }

  // ── CLOSE ─────────────────────────────────────────────────────────────────────────────────────
  if (req.method === 'PATCH') {
    const { id, closedReason } = (req.body || {}) as { id?: string; closedReason?: string };
    if (!id) return res.status(400).json({ message: 'id is required.' });
    const item = await prisma.vehicleDueItem.findFirst({
      where: { id, group_id: groupId },
      select: { id: true, closed_at: true, vehicle: { select: { job_cards: { select: { site_id: true }, take: 1, orderBy: { created_at: 'desc' } } } } },
    });
    if (!item) return res.status(404).json({ message: 'Item not found.' });
    const siteId = item.vehicle?.job_cards?.[0]?.site_id ?? null;
    const vis = await getVisibility(user.id as string);
    if (siteId && !canAccessSite(vis, siteId)) return res.status(403).json({ message: 'You do not have access to this vehicle’s location.' });
    if (item.closed_at) return res.status(200).json({ message: 'Already closed.' }); // idempotent
    await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      await tx.vehicleDueItem.update({
        where: { id },
        data: { closed_at: new Date(), closed_reason: (closedReason ?? '').trim().slice(0, 300) || null },
      });
      await writeAudit(tx, {
        groupId, userId: user.id as string,
        // Keyed on the ITEM, not a card: a finding closed a year later belongs to the car's
        // history, and the card it was found on may be long gone.
        entity: 'VehicleDueItem', entityId: id,
        action: 'due_item.closed', diff: { closedReason: closedReason ?? null },
      });
    });
    return res.status(200).json({ ok: true });
  }

  // ── RECORD ────────────────────────────────────────────────────────────────────────────────────
  const b = (req.body || {}) as {
    jobCardId?: string; description?: string; dueBasis?: DueBasis;
    dueDate?: string; dueMileage?: number | string; customerResponse?: DueItemResponse;
  };
  if (!b.jobCardId) return res.status(400).json({ message: 'jobCardId is required.' });

  const card = await prisma.jobCard.findFirst({
    where: { id: b.jobCardId, group_id: groupId },
    select: { id: true, site_id: true, vehicle_id: true },
  });
  if (!card) return res.status(404).json({ message: 'Job card not found.' });
  const vis = await getVisibility(user.id as string);
  if (!canAccessSite(vis, card.site_id)) return res.status(403).json({ message: 'You do not have access to this job card’s location.' });

  const dueDate = b.dueDate && /^\d{4}-\d{2}-\d{2}$/.test(b.dueDate) ? new Date(`${b.dueDate}T00:00:00.000Z`) : null;
  const dueMileageRaw = b.dueMileage == null || b.dueMileage === '' ? null : Number(b.dueMileage);
  const dueMileage = Number.isFinite(dueMileageRaw) ? Math.round(dueMileageRaw as number) : null;

  // THE ONE PREDICATE. Both "no basis chosen" and "no response chosen" refuse here, so a client
  // that forgot to make someone choose cannot quietly write a defaulted row.
  const refusal = refuseDueItem({
    description: b.description ?? '',
    dueBasis: b.dueBasis,
    dueDate, dueMileage,
    customerResponse: b.customerResponse,
  });
  if (refusal) return res.status(400).json({ code: refusal.code, message: refusal.message });

  const now = new Date();
  const row = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    const created = await tx.vehicleDueItem.create({
      data: {
        group_id: groupId,
        vehicle_id: card.vehicle_id,            // FROM THE CARD, never the client
        found_on_job_card_id: card.id,
        description: (b.description as string).trim().slice(0, 500),
        due_basis: b.dueBasis as DueBasis,
        // The non-binding value is still stored as context; only the basis decides what binds.
        due_date: dueDate,
        due_mileage: dueMileage,
        customer_response: b.customerResponse as DueItemResponse,
        response_at: responseAtFor(b.customerResponse as DueItemResponse, now),
        created_by: user.id as string,
      },
      select: { id: true },
    });
    await writeAudit(tx, {
      groupId, userId: user.id as string, jobCardId: card.id,
      action: 'due_item.found',
      diff: { description: b.description, dueBasis: b.dueBasis, dueDate: b.dueDate ?? null, dueMileage, customerResponse: b.customerResponse },
    });
    return created;
  });
  return res.status(200).json({ ok: true, id: row.id });
}
