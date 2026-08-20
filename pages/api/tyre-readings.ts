/**
 * File: pages/api/tyre-readings.ts
 * POST { jobCardId, corners: [{ corner, type, depths: { outer, centre, inner } }] }
 *
 * OPERATIONAL authority — this is the person crouched at the wheel. One transaction: the readings
 * and the advisories they raise land together, or neither does.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import { refuseBayWrite, bayWriteCard, BAY_WRITE_SELECT } from '@/lib/bay-write';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/pages/api/auth/[...nextauth]';
import { getVisibility } from '@/lib/site-visibility';
import { canAccessSite } from '@/lib/admin-guard';
import { writeAudit } from '@/lib/audit';
import { recordTyreReadings, type TyreCorner, type TyreType } from '@/lib/tyres';

const CORNERS: readonly TyreCorner[] = ['front_left', 'front_right', 'rear_left', 'rear_right'];
const TYPES: readonly TyreType[] = ['summer_standard', 'summer_runflat', 'winter_standard', 'winter_runflat'];
const depthOk = (n: unknown) => Number.isInteger(n) && (n as number) > 0 && (n as number) <= 250;

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).json({ message: 'Method Not Allowed' }); }
  const session = await getServerSession(req, res, authOptions);
  const user = session?.user as any;
  if (!user?.id || !user?.group_id) return res.status(401).json({ message: 'Not authenticated.' });
  const groupId = user.group_id as string;

  const { jobCardId, corners } = (req.body || {}) as {
    jobCardId?: string;
    corners?: Array<{ corner: TyreCorner; type: TyreType; depths: { outer: number; centre: number; inner: number } }>;
  };
  if (!jobCardId || !Array.isArray(corners) || !corners.length) {
    return res.status(400).json({ message: 'A job card and at least one corner are required.' });
  }
  for (const c of corners) {
    if (!CORNERS.includes(c?.corner) || !TYPES.includes(c?.type)) return res.status(400).json({ message: 'Unknown corner or tyre type.' });
    // A depth of zero is not a reading — it is a field nobody filled. Refused rather than stored.
    if (!depthOk(c?.depths?.outer) || !depthOk(c?.depths?.centre) || !depthOk(c?.depths?.inner)) {
      return res.status(400).json({ message: 'Each tyre needs all three tread readings.' });
    }
  }

  const card = await prisma.jobCard.findFirst({
    where: { id: jobCardId, group_id: groupId },
    select: { id: true, site_id: true, vehicle_id: true, odometer_in: true, ...BAY_WRITE_SELECT },
  });
  if (!card) return res.status(404).json({ message: 'Job card not found.' });
  // ── A FINISHED JOB TAKES NO NEW BAY DATA ────────────────────────────────────────────────────
  // One predicate, seven writers. See lib/bay-write: the invoice freeze is the boundary and the
  // admin unlock is the way back, because both already exist and both are already audited.
  const bayRefusal = refuseBayWrite(bayWriteCard(card as never));
  if (bayRefusal) return res.status(409).json({ message: bayRefusal.message, code: bayRefusal.code });
  const vis = await getVisibility(user.id as string);
  if (!canAccessSite(vis, card.site_id)) return res.status(403).json({ message: 'You do not have access to this job card’s location.' });

  const out = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    const r = await recordTyreReadings(tx, {
      groupId, vehicleId: card.vehicle_id, jobCardId: card.id,
      measuredBy: user.id as string, odometer: card.odometer_in ?? null, corners,
    });
    await writeAudit(tx, {
      groupId, userId: user.id as string, jobCardId: card.id,
      action: 'tyres.recorded',
      diff: { corners: corners.map((c) => ({ corner: c.corner, type: c.type, ...c.depths })), advisoriesRaised: r.advisories },
    });
    return r;
  });
  return res.status(200).json({ ok: true, ...out });
}
