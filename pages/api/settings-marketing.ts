/**
 * File: pages/api/settings-marketing.ts
 * The three tenant-wide marketing settings. ADMIN only, through requireAdminApi.
 *
 * BLANK IS NULL AND NULL IS A VALUE. Both numeric settings are nullable and null means NEVER SET —
 * the platform default then applies. Coercing a blank to 0 would mean "snooze for no time at all"
 * and "chase from the moment it is sent", neither of which anybody asked for.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { prisma } from '@/lib/db';
import { requireAdminApi } from '@/lib/admin-guard';
import { writeAudit } from '@/lib/audit';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).json({ message: 'Method Not Allowed' }); }
  const vis = await requireAdminApi(req, res);
  if (!vis) return;
  if (!vis.groupId) return res.status(400).json({ message: 'No tenant context.' });
  const groupId = vis.groupId;
  const b = req.body as { expiredQuotes?: boolean; snoozeDays?: number | null; quoteHotDays?: number | null };

  // A DAY COUNT IS A WHOLE POSITIVE NUMBER OR IT IS NOTHING. Refusing 0 explicitly: a zero-day
  // snooze is a hide, which lib/marketing-lists already refuses in prose, and a zero-day chase
  // threshold means "the moment it is sent", which is what leaving it blank already expresses.
  const day = (v: unknown, name: string): number | null | undefined => {
    if (v == null) return null;
    if (!Number.isInteger(v) || (v as number) < 1 || (v as number) > 365) {
      res.status(400).json({ message: `${name} should be a whole number of days between 1 and 365, or left blank.` });
      return undefined;
    }
    return v as number;
  };
  const snoozeDays = day(b.snoozeDays, 'Snooze length');
  if (snoozeDays === undefined) return;
  const quoteHotDays = day(b.quoteHotDays, 'The chase-early setting');
  if (quoteHotDays === undefined) return;

  await prisma.$transaction(async (tx) => {
    await tx.group.update({
      where: { id: groupId },
      data: {
        marketing_expired_quotes: b.expiredQuotes !== false,
        marketing_snooze_days: snoozeDays,
        marketing_quote_hot_days: quoteHotDays,
      },
    });
    await writeAudit(tx, {
      groupId, userId: vis.userId, action: 'settings.marketing',
      entity: 'group', entityId: groupId,
      diff: { expiredQuotes: b.expiredQuotes !== false, snoozeDays, quoteHotDays },
    });
  });
  return res.status(200).json({ ok: true });
}
