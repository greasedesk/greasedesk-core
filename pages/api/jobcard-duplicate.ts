/**
 * File: pages/api/jobcard-duplicate.ts
 * Duplicate a job card's ESTIMATE onto a fresh card. POST { jobCardId } → { id }.
 *
 * The recovery path for a cancelled/completed (read-only) card: the source is READ, never written —
 * this route deliberately ignores the cancelled edit-disable because it edits nothing. The new card
 * is a clean draft: no booking, no photos, no stage completions or skips, no invoice, no comeback
 * flag (a duplicate silently becoming zero-revenue would drag margin with no visible cause), no
 * mileage (mileage belongs to a visit, not a quote).
 *
 * WHAT COPIES: every JobCardItem verbatim — description, qty, unit_price, unit_cost (NULL copies as
 * NULL: cost UNKNOWN is a state, never zero), vat_rate, vat_amount, labour_hours, labour_outsourced,
 * catalogue_item_id (origin hook) and cost_basis (provenance) — plus the card's vat_rate, the four
 * stored totals (so the estimate total matches without a re-save) and the job-nature flags.
 *
 * CUSTOMER (ruling 2026-07-28): resolved to the vehicle's CURRENT owner at duplicate time (car-first
 * spine — invoicing already resolves recipients through the edge); falls back to the source card's
 * customer only where no ownership edge exists. When the two differ the card page shows the
 * ownership-change notice naming both.
 *
 * costs_inherited marks the copied numbers as potentially stale; the first estimate save clears it.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { prisma } from '@/lib/db';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/pages/api/auth/[...nextauth]';
import { Prisma } from '@prisma/client';
import { getVisibility } from '@/lib/site-visibility';
import { getTenantPermissions, canEditEstimate } from '@/lib/permissions';
import { requireCanWrite } from '@/lib/admin-guard';
import { getCurrentOwnerId } from '@/lib/vehicle-identity';
import { writeAudit } from '@/lib/audit';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ message: 'Method Not Allowed' });
  }
  const session = await getServerSession(req, res, authOptions);
  const user = session?.user as any;
  if (!user?.id || !user?.group_id) return res.status(401).json({ message: 'Not authenticated.' });

  const { jobCardId } = (req.body || {}) as { jobCardId?: string };
  if (!jobCardId) return res.status(400).json({ message: 'Missing jobCardId.' });

  const source = (await prisma.jobCard.findFirst({
    where: { id: jobCardId, group_id: user.group_id },
    include: {
      items: { orderBy: { created_at: 'asc' } },
      vehicle: { select: { registration: true } },
      customer: { select: { id: true, name: true } },
    },
  })) as any;
  if (!source) return res.status(404).json({ message: 'Job card not found.' });

  const vis = await getVisibility(user.id as string);
  const perms = await getTenantPermissions(user.group_id as string);
  // Duplicating copies prices AND costs onto an editable draft — estimate-edit authority is the gate.
  if (!canEditEstimate(vis, source.site_id, perms)) {
    return res.status(403).json({ message: 'You do not have permission to duplicate this job card.' });
  }
  if (!(await requireCanWrite(user.group_id as string, res))) return; // lapsed = read-only; a new card is new work

  // CAR-FIRST: the new card belongs to whoever owns the vehicle NOW; the source card's customer is
  // the fallback for edge-less vehicles only.
  const ownerId = source.vehicle_id ? await getCurrentOwnerId(prisma, source.vehicle_id as string) : null;
  const customerId: string | null = ownerId ?? source.customer_id ?? null;
  const ownershipChanged = !!(source.customer_id && customerId && source.customer_id !== customerId);

  const created = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    const card = await tx.jobCard.create({
      data: {
        group_id: source.group_id,
        site_id: source.site_id,
        vehicle_id: source.vehicle_id,
        customer_id: customerId,
        // status stays the default 'draft'; stages/skips stay false; booking, photos, invoice,
        // odometers, comeback and sign-off all stay empty — only the estimate travels.
        vat_rate: source.vat_rate,
        labour_bill_numeric: source.labour_bill_numeric,
        parts_bill_numeric: source.parts_bill_numeric,
        flag_urgent: source.flag_urgent,
        flag_sales_car: source.flag_sales_car,
        flag_customer_car: source.flag_customer_car,
        flag_mot: source.flag_mot,
        flag_diag: source.flag_diag,
        duplicated_from_id: source.id,
        costs_inherited: (source.items as any[]).length > 0,
      },
      select: { id: true },
    });
    if ((source.items as any[]).length) {
      await tx.jobCardItem.createMany({
        data: (source.items as any[]).map((it) => ({
          job_card_id: card.id,
          item_type: it.item_type,
          description: it.description,
          qty: it.qty,
          unit_price: it.unit_price,
          unit_cost: it.unit_cost, // NULL copies as NULL — cost UNKNOWN is preserved, never invented as 0
          vat_rate: it.vat_rate,
          vat_amount: it.vat_amount,
          labour_hours: it.labour_hours,
          labour_outsourced: it.labour_outsourced,
          catalogue_item_id: it.catalogue_item_id,
          cost_basis: it.cost_basis,
        })),
      });
    }
    await writeAudit(tx, {
      groupId: user.group_id as string, userId: user.id as string, jobCardId: card.id,
      action: 'card.duplicated',
      diff: {
        source_card_id: source.id,
        source_registration: source.vehicle?.registration ?? null,
        source_status: source.status,
        lines: (source.items as any[]).length,
        ownership_changed: ownershipChanged,
        previous_customer: ownershipChanged ? (source.customer?.name ?? null) : undefined,
      },
    });
    return card;
  });

  return res.status(201).json({ id: created.id, message: 'Job card duplicated.' });
}
