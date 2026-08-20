/**
 * File: pages/api/mot-refresh.ts
 * POST { vehicleId } — ask DVSA about ONE car, now, because someone is about to ring its owner.
 *
 * ── NOT A REPAIR FOR ROWS THAT LOOK WRONG ───────────────────────────────────────────────────────
 * Any stored MOT date is stale the moment it is stored; the car can be tested anywhere, and we
 * hear about it only when we look. This is a normal step in working the list — pressed beside the
 * phone number as a matter of course, not a fix for a row someone distrusts.
 *
 * ── THE SECOND CALLER OF motFieldsToWrite ───────────────────────────────────────────────────────
 * The sweep and the button must not diverge: refresh-don't-fill, an earlier expiry overwrites
 * (DVSA correcting us), and an ABSENCE never erases. One pure function, both callers, proved
 * without a network call. See lib/dvsa.
 *
 * ── AND IT KEEPS THE HISTORY ────────────────────────────────────────────────────────────────────
 * The response carries the whole motTests array. Dropping it would make a per-row check produce
 * worse mileage rates than the sweep does — a defect wearing a feature's clothes. Best-effort, as
 * everywhere else: a storage failure must never turn a working check into a failed one.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { prisma } from '@/lib/db';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/pages/api/auth/[...nextauth]';
import { dvsaLookup, motFieldsToWrite } from '@/lib/dvsa';
import { recordOdometerReadings } from '@/lib/odometer';
import { motBand } from '@/lib/marketing-lists';
import { refreshOutcome } from '@/lib/mot-refresh';
import { writeAudit } from '@/lib/audit';

const iso = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  // Never cached: the entire point is that this executes. See pages/api/dvsa-lookup.
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).json({ message: 'Method Not Allowed' }); }
  const session = await getServerSession(req, res, authOptions);
  const user = session?.user as any;
  if (!user?.id || !user?.group_id) return res.status(401).json({ message: 'Not authenticated.' });
  const groupId = user.group_id as string;

  const vehicleId = typeof req.body?.vehicleId === 'string' ? req.body.vehicleId : null;
  if (!vehicleId) return res.status(400).json({ message: 'Which car?' });

  // TENANT-SCOPED IN THE WHERE, not checked after. A car from another garage is a 404, not a 403.
  const v = await prisma.vehicle.findFirst({
    where: { id: vehicleId, group_id: groupId },
    select: { id: true, registration: true, mot_expiry: true, last_mot_mileage: true, last_mot_date: true },
  });
  if (!v) return res.status(404).json({ message: 'Car not found.' });

  const before = iso(v.mot_expiry);
  const data = await dvsaLookup(v.registration);

  // ── A LOOKUP THAT FAILED STAMPS NOTHING ───────────────────────────────────────────────────────
  // Not the fields, and not mot_checked_at. DVSA returns null for a 404, a 403, a 429, a timeout
  // and an unconfigured credential alike — none of which is news about this car, and all of which
  // would otherwise leave the row saying it had been checked.
  if (!data) {
    return res.status(200).json({
      outcome: refreshOutcome({ answered: false, heldBefore: before, heldAfter: before, stillDue: true }),
      checkedAt: null,
    });
  }

  const write = motFieldsToWrite(
    { mot_expiry: v.mot_expiry, last_mot_mileage: v.last_mot_mileage, last_mot_date: v.last_mot_date },
    data,
  );
  const checkedAt = new Date();
  await prisma.vehicle.update({ where: { id: v.id }, data: { ...write, mot_checked_at: checkedAt } });

  // Free, and already in the response. Best-effort — see the header.
  if (data.odometerHistory?.length) {
    try {
      await recordOdometerReadings(prisma, { groupId, vehicleId: v.id, source: 'mot', readings: data.odometerHistory });
    } catch (e) { console.error('[mot-refresh] odometer store failed (non-fatal)', e); }
  }

  const after = write.mot_expiry !== undefined ? iso(write.mot_expiry as Date) : before;
  // THE BAND RULE IS NOT RE-DERIVED — motBand is the same function the list is built from, so a
  // row cannot disagree with the band it is sitting in about what "due" means.
  const stillDue = motBand(after ? new Date(`${after}T00:00:00.000Z`) : null, new Date()) !== null;
  const outcome = refreshOutcome({ answered: true, heldBefore: before, heldAfter: after, stillDue });

  if (Object.keys(write).length) {
    // ONLY WHEN SOMETHING MOVED. A row per press would be noise in an append-only table, and the
    // "we looked" fact already has a home in mot_checked_at. What is audited is the CHANGE.
    await writeAudit(prisma, {
      groupId, userId: user.id as string, action: 'vehicle.mot_refresh',
      entity: 'vehicle', entityId: v.id,
      diff: { registration: v.registration, before, after, fields: Object.keys(write) },
    }).catch(() => {});
  }

  return res.status(200).json({ outcome, checkedAt: checkedAt.toISOString() });
}
