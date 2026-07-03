/**
 * File: pages/api/jobcard-details.ts
 * Edit the CURRENT owner + the vehicle from the Customer Details tab, while the car is in the garage's
 * care. POST { jobCardId, owner?, vehicle?, confirmReg? }.
 *
 * Car-first: the owner is resolved via the VehicleOwnership edge (getCurrentOwnerId) — the first EDIT
 * use of the edge, mirroring the tab's read. This edits the current owner IN PLACE; it never changes
 * WHO the owner is (that's the banked custody-transfer mechanism). OPERATIONAL authority (canAccessSite)
 * — same tier as the stage/mileage controls a mechanic uses mid-job. Owner + vehicle + the per-visit
 * odometer_in are updated in ONE tx, audited (entity job_card) with a changed-fields-only diff.
 *
 * Registration soft-guard: editing a reg to one already present at the tenant returns 409 REG_COLLISION
 * (non-blocking — resubmit with confirmReg:true). Reg has no unique constraint and a duplicate poisons
 * the find-or-create hot path, so we surface it to the person with context rather than accept it silently.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { prisma } from '@/lib/db';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/pages/api/auth/[...nextauth]';
import { Prisma } from '@prisma/client';
import { getVisibility } from '@/lib/site-visibility';
import { canAccessSite } from '@/lib/admin-guard';
import { getCurrentOwnerId, normalizeVin } from '@/lib/vehicle-identity';
import { writeAudit } from '@/lib/audit';

type OwnerIn = { name?: string; phone?: string; email?: string; address?: string };
type VehicleIn = { registration?: string; vin?: string; mileageIn?: number | string };
const clean = (v?: string) => { const s = (v ?? '').trim(); return s.length ? s : null; };
const emailish = (v: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ message: 'Method Not Allowed' });
  }
  const session = await getServerSession(req, res, authOptions);
  const user = session?.user as any;
  if (!user?.id || !user?.group_id) return res.status(401).json({ message: 'Not authenticated.' });

  const { jobCardId, owner, vehicle, confirmReg } = (req.body || {}) as { jobCardId?: string; owner?: OwnerIn; vehicle?: VehicleIn; confirmReg?: boolean };
  if (!jobCardId) return res.status(400).json({ message: 'Missing jobCardId.' });

  const card = (await prisma.jobCard.findFirst({
    where: { id: jobCardId, group_id: user.group_id },
    select: { id: true, site_id: true, vehicle_id: true, odometer_in: true, vehicle: { select: { registration: true, vin: true } } },
  })) as any;
  if (!card) return res.status(404).json({ message: 'Job card not found.' });

  const vis = await getVisibility(user.id as string);
  if (!canAccessSite(vis, card.site_id)) return res.status(403).json({ message: 'You do not have access to this job card’s location.' });

  // ----- validate -----
  let ownerId: string | null = null;
  if (owner) {
    ownerId = await getCurrentOwnerId(prisma, card.vehicle_id as string);
    if (!ownerId) return res.status(409).json({ message: 'This vehicle has no current owner to edit.' });
    if (owner.name !== undefined && !clean(owner.name)) return res.status(400).json({ message: 'Customer name cannot be empty.' });
    if (owner.email !== undefined && clean(owner.email) && !emailish(clean(owner.email)!)) return res.status(400).json({ message: 'That email address looks invalid.' });
  }
  let newReg: string | null = null;
  let mileageVal: number | null | undefined = undefined;
  if (vehicle) {
    if (vehicle.registration !== undefined) {
      newReg = clean(vehicle.registration);
      if (!newReg) return res.status(400).json({ message: 'Registration cannot be empty.' });
    }
    if (vehicle.mileageIn !== undefined && vehicle.mileageIn !== null && String(vehicle.mileageIn).trim() !== '') {
      const n = Number(vehicle.mileageIn);
      if (!Number.isFinite(n) || n < 0) return res.status(400).json({ message: 'Invalid mileage.' });
      mileageVal = Math.trunc(n);
    } else if (vehicle.mileageIn !== undefined) {
      mileageVal = null;
    }
  }

  // ----- registration soft-guard (non-blocking) -----
  if (newReg && newReg !== card.vehicle?.registration && !confirmReg) {
    const other = await prisma.vehicle.findFirst({ where: { group_id: user.group_id, registration: newReg, id: { not: card.vehicle_id } }, select: { id: true } });
    if (other) return res.status(409).json({ code: 'REG_COLLISION', message: 'A vehicle with this registration already exists here. Continue anyway?' });
  }

  // ----- one transaction: owner + vehicle + odometer_in + audit (changed fields only) -----
  try {
    await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      if (owner && ownerId) {
        const cur = (await tx.customer.findUnique({ where: { id: ownerId }, select: { name: true, phone: true, email: true, address: true } })) as any;
        const next: any = {};
        const diff: any = {};
        const set = (k: string, v: any, curV: any) => { if (v !== undefined && v !== curV) { next[k] = v; diff[k] = { from: curV, to: v }; } };
        if (owner.name !== undefined) set('name', clean(owner.name), cur.name);
        if (owner.phone !== undefined) set('phone', clean(owner.phone), cur.phone);
        if (owner.email !== undefined) set('email', clean(owner.email), cur.email);
        if (owner.address !== undefined) set('address', clean(owner.address), cur.address);
        if (Object.keys(next).length) {
          await tx.customer.update({ where: { id: ownerId }, data: next });
          await writeAudit(tx, { groupId: user.group_id as string, userId: user.id as string, jobCardId, action: 'owner.edited', diff });
        }
      }
      if (vehicle) {
        const vnext: any = {};
        const vdiff: any = {};
        if (newReg !== null && newReg !== card.vehicle?.registration) { vnext.registration = newReg; vdiff.registration = { from: card.vehicle?.registration, to: newReg }; }
        if (vehicle.vin !== undefined) {
          const nv = clean(vehicle.vin);
          if (nv !== card.vehicle?.vin) { vnext.vin = nv; vnext.vin_normalized = normalizeVin(nv); vdiff.vin = { from: card.vehicle?.vin, to: nv }; }
        }
        if (Object.keys(vnext).length) await tx.vehicle.update({ where: { id: card.vehicle_id }, data: vnext });
        if (mileageVal !== undefined && mileageVal !== card.odometer_in) { await tx.jobCard.update({ where: { id: jobCardId }, data: { odometer_in: mileageVal } }); vdiff.mileageIn = { from: card.odometer_in, to: mileageVal }; }
        if (Object.keys(vdiff).length) await writeAudit(tx, { groupId: user.group_id as string, userId: user.id as string, jobCardId, action: 'vehicle.edited', diff: vdiff });
      }
    });
  } catch (e) {
    console.error('jobcard-details edit error:', e);
    return res.status(500).json({ message: 'Could not save the details.' });
  }
  return res.status(200).json({ message: 'Details saved.' });
}
