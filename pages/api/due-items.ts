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
import { refuseClosure, closureFields } from '@/lib/due-item-closure';
import { refuseDueItem, responseAtFor, openDueItemsForVehicle, closureOffersForCard, type DueBasis, type DueItemResponse } from '@/lib/due-items';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST' && req.method !== 'PATCH' && req.method !== 'GET' && req.method !== 'PUT') {
    res.setHeader('Allow', 'GET, POST, PATCH, PUT');
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
    const items = await openDueItemsForVehicle(prisma, groupId, c.vehicle_id);
    const offers = await closureOffersForCard(prisma, groupId, items.map((i) => i.id));
    return res.status(200).json({
      items: items.map((i) => ({ ...i, closureOffer: offers.get(i.id) ?? { offer: false, reason: 'no_lines' } })),
    });
  }

  // ── LINK A FINDING TO AN ESTIMATE LINE ────────────────────────────────────────────────────────
  // The customer said yes; someone priced it. This records WHICH line answers WHICH finding, so the
  // card can later offer to close the finding — and so that "invoiced" never silently means "done".
  if (req.method === 'PUT') {
    const { dueItemId, jobCardItemId, unlink } = (req.body || {}) as { dueItemId?: string; jobCardItemId?: string; unlink?: boolean };
    if (!dueItemId || !jobCardItemId) return res.status(400).json({ message: 'An item and a line are required.' });
    // BOTH SIDES tenant-checked, and the line's card must be one the caller can reach.
    const line = await prisma.jobCardItem.findFirst({
      where: { id: jobCardItemId, job_card: { group_id: groupId } },
      select: { id: true, job_card: { select: { site_id: true } } },
    });
    const found = await prisma.vehicleDueItem.findFirst({ where: { id: dueItemId, group_id: groupId }, select: { id: true } });
    if (!line || !found) return res.status(404).json({ message: 'Not found.' });
    const v2 = await getVisibility(user.id as string);
    if (!canAccessSite(v2, line.job_card.site_id)) return res.status(403).json({ message: 'You do not have access to that job card’s location.' });

    if (unlink) {
      await prisma.dueItemLine.deleteMany({ where: { due_item_id: dueItemId, job_card_item_id: jobCardItemId } });
      return res.status(200).json({ ok: true, linked: false });
    }
    // Idempotent: the unique pair makes a second link a no-op rather than a duplicate.
    await prisma.dueItemLine.upsert({
      where: { due_item_id_job_card_item_id: { due_item_id: dueItemId, job_card_item_id: jobCardItemId } },
      create: { group_id: groupId, due_item_id: dueItemId, job_card_item_id: jobCardItemId, linked_by: user.id as string },
      update: {},
    });
    return res.status(200).json({ ok: true, linked: true });
  }

  // ── CLOSE ─────────────────────────────────────────────────────────────────────────────────────
  if (req.method === 'PATCH') {
    // ── A CLOSURE NOW SAYS WHY, AND THE KIND IS REQUIRED ────────────────────────────────────────
    // This accepted an OPTIONAL closedReason and the only caller sent neither it nor a card, so
    // every human closure through the job card wrote closed_reason NULL and closed_job_card_id
    // NULL — two of TMBS's three closed findings are in that state, and nothing can tell whether
    // the garage did the work or the customer refused it. The kind is now demanded.
    const { id, closedKind, closedReason, jobCardId } = (req.body || {}) as
      { id?: string; closedKind?: string; closedReason?: string; jobCardId?: string };
    if (!id) return res.status(400).json({ message: 'id is required.' });
    const refusal = refuseClosure({ kind: closedKind as never, note: closedReason ?? null, jobCardId: jobCardId ?? null });
    if (refusal) return res.status(400).json({ message: refusal.message, code: refusal.code });
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
        data: closureFields({ kind: closedKind as never, note: closedReason ?? null, jobCardId: jobCardId ?? null }),
      });
      await writeAudit(tx, {
        groupId, userId: user.id as string,
        // Keyed on the ITEM, not a card: a finding closed a year later belongs to the car's
        // history, and the card it was found on may be long gone.
        entity: 'VehicleDueItem', entityId: id,
        action: 'due_item.closed', diff: { closedKind, closedReason: closedReason ?? null, jobCardId: jobCardId ?? null },
      });
    });
    return res.status(200).json({ ok: true });
  }

  // ── RECORD ────────────────────────────────────────────────────────────────────────────────────
  const b = (req.body || {}) as {
    jobCardId?: string; description?: string; dueBasis?: DueBasis;
    dueDate?: string; dueMileage?: number | string; customerResponse?: DueItemResponse;
    /** Capture-time id from the phone's outbox — see the idempotency note below. */
    id?: string;
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

  // ── IDEMPOTENCY: A CAPTURE-TIME ID, BECAUSE THE PHONE REPLAYS ─────────────────────────────────
  // The PWA outbox retries anything that failed transiently, and a POST that already SUCCEEDED but
  // whose response was lost looks identical to one that never arrived. Without a stable id, a
  // mechanic in a dead-signal bay records one finding and the garage gets two.
  //
  // So the client may mint the id AT CAPTURE and the write becomes an upsert on it — exactly the
  // hinge pages/api/photos/presign already uses for photoId. A UUID or nothing; never trusted into
  // a key unvalidated.
  //
  // WHY /api/tyre-readings NEEDED NO SUCH FIX, and why nobody should "simplify" it away:
  // TyreReading is unique on (job_card_id, corner) — a NATURAL key. One car has one front-left
  // tyre per visit, so a replayed envelope upserts the same row by construction and a second
  // delivery is a no-op without anyone passing an id. A due item has no natural key: two genuine
  // findings on one card can legitimately read the same, so nothing about the data distinguishes a
  // duplicate from a real pair. That is the whole difference, and it is why the tyre unique
  // constraint is load-bearing rather than tidiness.
  if (b.id !== undefined && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(b.id))) {
    return res.status(400).json({ message: 'id must be a UUID.' });
  }
  const clientId = b.id ? String(b.id).toLowerCase() : null;

  const now = new Date();
  const row = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    // Upsert when the client named the row; plain create otherwise (the desktop path, unchanged).
    if (clientId) {
      const existing = await tx.vehicleDueItem.findUnique({ where: { id: clientId }, select: { id: true, group_id: true } });
      if (existing) {
        // A REPLAY, not a second finding. Tenant-checked before it is treated as ours.
        if (existing.group_id !== groupId) return { id: existing.id, replayed: true as const, foreign: true as const };
        return { id: existing.id, replayed: true as const };
      }
    }
    const created = await tx.vehicleDueItem.create({
      data: {
        ...(clientId ? { id: clientId } : {}),
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
    // A FINDING CONTRADICTS "nothing found". Cleared here rather than left to disagree: the current
    // state is "findings exist", and a card asserting both at once says two things. The audit log
    // keeps the history of both events.
    await tx.jobCard.update({ where: { id: card.id }, data: { intake_nothing_found_at: null, intake_nothing_found_by: null } });
    await writeAudit(tx, {
      groupId, userId: user.id as string, jobCardId: card.id,
      action: 'due_item.found',
      diff: { description: b.description, dueBasis: b.dueBasis, dueDate: b.dueDate ?? null, dueMileage, customerResponse: b.customerResponse },
    });
    return { id: created.id, replayed: false as const };
  });
  // A replay reports success: the finding exists, which is what the caller wanted. Never a 409 —
  // the outbox would treat that as a failure and retry forever.
  if ('foreign' in row && row.foreign) return res.status(409).json({ message: 'That id belongs to another tenant.' });
  return res.status(200).json({ ok: true, id: row.id, replayed: row.replayed });
}
