/**
 * File: pages/api/service-schedule.ts
 * POST { jobCardId, entries: [{ key, dueDate?, dueMileage? }] } — the service computer, transcribed.
 *
 * OPERATIONAL authority. One transaction: the whole schedule lands, or none of it does — a garage
 * reading half a schedule back would not know which half.
 *
 * ── REPLAY-SAFE WITH NO CLIENT ID, LIKE EVERYTHING ELSE THAT HAS A NATURAL KEY ──────────────────
 * (group, vehicle, observation_key) is unique WHILE OPEN, so re-sending the same schedule updates
 * the same rows. A schedule is a CURRENT STATE, not a log: recording it again next visit should
 * correct it, and that is what the constraint already makes happen.
 *
 * ── A BLANK ROW CLEARS, IT DOES NOT SKIP ────────────────────────────────────────────────────────
 * Emptying a row the garage previously recorded is a statement — that item is no longer scheduled —
 * so the open item is CLOSED rather than left standing. Anything else would make a wrong date
 * impossible to retract, which is the sort of thing people work around by typing 1970 into a field.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/pages/api/auth/[...nextauth]';
import { getVisibility } from '@/lib/site-visibility';
import { canAccessSite } from '@/lib/admin-guard';
import { writeAudit } from '@/lib/audit';
import { scheduleByKey, refuseSchedule, basisFor, isBlank, type ScheduleEntry, type ScheduleKey } from '@/lib/service-schedule';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).json({ message: 'Method Not Allowed' }); }
  const session = await getServerSession(req, res, authOptions);
  const user = session?.user as any;
  if (!user?.id || !user?.group_id) return res.status(401).json({ message: 'Not authenticated.' });
  const groupId = user.group_id as string;

  const { jobCardId, entries } = (req.body || {}) as { jobCardId?: string; entries?: ScheduleEntry[] };
  if (!jobCardId || !Array.isArray(entries)) return res.status(400).json({ message: 'A job card and its schedule are required.' });
  for (const e of entries) {
    if (!scheduleByKey(String(e?.key))) return res.status(400).json({ message: 'Unknown schedule item.' });
  }
  const refusals = refuseSchedule(entries);
  if (refusals.length) return res.status(400).json({ message: refusals[0].message, refusals });

  const card = await prisma.jobCard.findFirst({
    where: { id: jobCardId, group_id: groupId },
    select: { id: true, site_id: true, vehicle_id: true },
  });
  if (!card) return res.status(404).json({ message: 'Job card not found.' });
  const vis = await getVisibility(user.id as string);
  if (!canAccessSite(vis, card.site_id)) return res.status(403).json({ message: 'You do not have access to this job card’s location.' });

  const result = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    let written = 0, cleared = 0;
    for (const e of entries) {
      const item = scheduleByKey(String(e.key)) as { key: ScheduleKey; description: string };
      const open = await tx.vehicleDueItem.findFirst({
        where: { group_id: groupId, vehicle_id: card.vehicle_id, closed_at: null, observation_key: item.key },
        select: { id: true },
      });

      if (isBlank(e)) {
        // CLEARED, not ignored — see the header. A garage emptying a row is retracting it.
        if (open) {
          await tx.vehicleDueItem.update({
            where: { id: open.id },
            data: { closed_at: new Date(), closed_job_card_id: card.id, closed_reason: 'No longer scheduled' },
          });
          cleared++;
        }
        continue;
      }

      const data = {
        observation_key: item.key,
        description: item.description,
        due_basis: basisFor(e) as 'date' | 'mileage' | 'whichever_first',
        due_date: e.dueDate ? new Date(`${e.dueDate}T00:00:00.000Z`) : null,
        due_mileage: e.dueMileage ?? null,
        // The description says WHAT and the basis says WHEN — no timing in the words.
        timing_in_description: false,
      };
      if (open) await tx.vehicleDueItem.update({ where: { id: open.id }, data });
      else {
        await tx.vehicleDueItem.create({
          data: {
            group_id: groupId, vehicle_id: card.vehicle_id, found_on_job_card_id: card.id,
            // DEFAULTED HERE AND NOWHERE ELSE. A schedule row is transcribed ten months before the
            // conversation it would be an answer to — see lib/service-schedule, and the matching
            // note at lib/due-items where the opposite rule lives.
            customer_response: 'not_raised' as never,
            created_by: user.id as string,
            ...data,
          },
        });
      }
      written++;
    }
    await writeAudit(tx, {
      groupId, userId: user.id as string, jobCardId,
      action: 'service_schedule.recorded',
      diff: { written, cleared, entries: entries.filter((e) => !isBlank(e)).map((e) => ({ key: e.key, dueDate: e.dueDate ?? null, dueMileage: e.dueMileage ?? null })) },
    });
    return { written, cleared };
  });

  return res.status(200).json({ ok: true, ...result });
}
