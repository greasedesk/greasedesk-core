/**
 * File: pages/api/battery-readings.ts
 * POST { jobCardId, voltage (V, decimal string or number), socPct, sohPct, ratedCca?, ccaStandard? }
 *
 * OPERATIONAL authority — this is the person holding the tester. One transaction: the reading and
 * whatever it advises land together, or neither does.
 *
 * ── NO CLIENT-SUPPLIED id, AND THAT IS NOT AN OVERSIGHT ─────────────────────────────────────────
 * /api/due-items takes one because a finding has NO natural key: send the same envelope twice from
 * a phone that lost signal mid-request and the garage gets two identical findings. A battery test
 * has a natural key — one per visit, unique on job_card_id — so a redelivered envelope upserts the
 * same row by construction. The same argument as tyre readings, reached the same way. Do not
 * "simplify" that unique constraint away; it is what makes the phone's replay safe.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/pages/api/auth/[...nextauth]';
import { getVisibility } from '@/lib/site-visibility';
import { canAccessSite } from '@/lib/admin-guard';
import { writeAudit } from '@/lib/audit';
import { recordBatteryReading, CCA_STANDARDS, MIN_RATED_CCA, MAX_RATED_CCA, type CcaStandard } from '@/lib/battery';

const pct = (n: unknown) => Number.isInteger(n) && (n as number) >= 0 && (n as number) <= 100;

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).json({ message: 'Method Not Allowed' }); }
  const session = await getServerSession(req, res, authOptions);
  const user = session?.user as any;
  if (!user?.id || !user?.group_id) return res.status(401).json({ message: 'Not authenticated.' });
  const groupId = user.group_id as string;

  const b = (req.body || {}) as {
    jobCardId?: string; voltage?: number | string; socPct?: number; sohPct?: number;
    ratedCca?: number | null; ccaStandard?: string | null;
  };
  if (!b.jobCardId) return res.status(400).json({ message: 'A job card is required.' });

  // Volts in, millivolts stored: the thresholds are integers because 10.5V is a boundary and
  // floating point has no business near a boundary.
  const voltsNum = typeof b.voltage === 'string' ? Number(b.voltage) : b.voltage;
  if (typeof voltsNum !== 'number' || !Number.isFinite(voltsNum) || voltsNum <= 0 || voltsNum > 30) {
    return res.status(400).json({ message: 'Voltage must be a number between 0 and 30.' });
  }
  const voltageMv = Math.round(voltsNum * 1000);
  if (!pct(b.socPct) || !pct(b.sohPct)) {
    return res.status(400).json({ message: 'Charge and health must be whole percentages between 0 and 100.' });
  }

  // BOTH OR NEITHER. A rated CCA without its standard is not comparable to another rated CCA — EN,
  // SAE and DIN rate the same battery differently — and the health percentage is computed against
  // it. The database enforces this too; refusing here means the mechanic gets a sentence rather
  // than a constraint violation.
  const ratedCca = b.ratedCca == null || b.ratedCca === ('' as never) ? null : Number(b.ratedCca);
  const ccaStandard = b.ccaStandard ? String(b.ccaStandard).toUpperCase() : null;
  if (ratedCca != null && (!Number.isInteger(ratedCca) || ratedCca < MIN_RATED_CCA || ratedCca > MAX_RATED_CCA)) {
    // HELPS, DOES NOT SCOLD. The person reading this is standing at a car with a tester in one hand
    // and a phone in the other, and the overwhelmingly likely cause is a digit dropped off the end.
    // So: say what we got, say where to find the right number, and give a realistic range to aim
    // at. No "invalid", no "must" — and it names the label on the battery rather than a rule.
    return res.status(400).json({
      message: `${ratedCca} CCA looks like a typo — most car batteries are between 400 and 800. The rating is printed on the battery label, next to the EN or SAE mark.`,
    });
  }
  if (ccaStandard != null && !CCA_STANDARDS.includes(ccaStandard as CcaStandard)) {
    return res.status(400).json({ message: 'Unknown CCA standard.' });
  }
  if ((ratedCca == null) !== (ccaStandard == null)) {
    return res.status(400).json({ message: 'A rated CCA needs its standard, and a standard needs its rating.' });
  }

  const card = await prisma.jobCard.findFirst({
    where: { id: b.jobCardId, group_id: groupId },
    select: { id: true, site_id: true, vehicle_id: true },
  });
  if (!card) return res.status(404).json({ message: 'Job card not found.' });
  const vis = await getVisibility(user.id as string);
  if (!canAccessSite(vis, card.site_id)) return res.status(403).json({ message: 'You do not have access to this job card’s location.' });

  const out = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    const r = await recordBatteryReading(tx, {
      groupId, vehicleId: card.vehicle_id, jobCardId: card.id, measuredBy: user.id as string,
      reading: { voltageMv, socPct: b.socPct as number, sohPct: b.sohPct as number, ratedCca, ccaStandard: ccaStandard as CcaStandard | null },
    });
    await writeAudit(tx, {
      groupId, userId: user.id as string, jobCardId: card.id,
      action: 'battery.recorded',
      diff: { voltageMv, socPct: b.socPct, sohPct: b.sohPct, ratedCca, ccaStandard, state: r.state, advisory: r.advisory },
    });
    return r;
  });
  return res.status(200).json({ ok: true, ...out });
}
