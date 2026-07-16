/**
 * File: pages/api/cron/reap-empty-drafts.ts
 * Reaping path for abandoned, EMPTY draft job cards (Option B hygiene). A draft is junk ONLY when it
 * has nothing of value: no estimate lines, no booking, no photos, no invoice — AND it's stale (older
 * than ?days, default 14). Deleting it (cascades its items/photos) frees the list of clutter without
 * ever risking real work. TMBS is excluded (standing rule). CRON_SECRET-guarded; ?dryRun=1 reports
 * without deleting. This is the counter-weight to autosave: WIP is never lost, junk never accumulates.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { prisma } from '@/lib/db';
import { TMBS_GROUP_ID } from '@/lib/superadmin';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.authorization !== `Bearer ${secret}`) return res.status(401).json({ message: 'Unauthorized.' });

  const days = Math.max(0, Number(req.query.days ?? 14));
  const dryRun = req.query.dryRun === '1';
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  // "Genuinely empty + abandoned draft": all the value-signals absent, and stale.
  const where = {
    status: 'draft' as const,
    group_id: { not: TMBS_GROUP_ID },   // never touch TMBS
    created_at: { lt: cutoff },
    resource_id: null,                  // not booked (start_at also null on an unbooked card)
    start_at: null,
    items: { none: {} },                // no estimate lines
    photos: { none: {} },               // no photos
    invoice: null,                      // never invoiced
  };

  const victims = (await prisma.jobCard.findMany({ where, select: { id: true, group_id: true, created_at: true } })) as Array<{ id: string; group_id: string; created_at: Date }>;
  if (dryRun) return res.status(200).json({ dryRun: true, days, count: victims.length, ids: victims.map((v) => v.id) });

  let deleted = 0;
  for (const v of victims) {
    // Delete cascades JobCardItem + JobCardPhoto (both onDelete: Cascade off JobCard).
    await prisma.jobCard.delete({ where: { id: v.id } }).then(() => { deleted += 1; }).catch(() => {});
  }
  return res.status(200).json({ dryRun: false, days, found: victims.length, deleted });
}
