/**
 * File: pages/api/cron/reap-rate-limits.ts
 * Deletes AuthRateLimit rows past their retention window. CRON_SECRET-guarded; ?dryRun=1 counts
 * without deleting.
 *
 * ── WHY A CRON AND NOT THE EXISTING PRUNE ───────────────────────────────────────────────────────
 * takeToken already prunes — but only the key it is currently taking, which means a key that never
 * recurs is never reached. A purged tenant's `sms:grp:<id>` cannot recur; a one-off IP usually
 * doesn't. The table was found holding rows three weeks old, including raw IP addresses and four
 * rows naming a tenant that had been purged that afternoon. A sweep that depends on traffic cannot
 * fix that, however often it runs.
 *
 * The window comes from lib/auth-rate-limit (twice the longest limit window), so it can never drift
 * out of step with the limits it serves.
 *
 * ── WHY THIS IS SAFE TO RUN AT ANY TIME ─────────────────────────────────────────────────────────
 * A deleted row can only ever make a limit MORE generous, and only for rows already too old to be
 * counted — every limit query filters `created_at >= now - window`, and the cutoff here is double
 * the longest window. Deleting them changes no decision.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { prisma } from '@/lib/db';
import { reapRateLimits, RATE_LIMIT_RETENTION_MINUTES } from '@/lib/auth-rate-limit';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  res.setHeader('Cache-Control', 'no-store');
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.authorization !== `Bearer ${secret}`) return res.status(401).json({ message: 'Unauthorized.' });

  const cutoff = new Date(Date.now() - RATE_LIMIT_RETENTION_MINUTES * 60 * 1000);

  if (req.query.dryRun === '1') {
    const [total, stale] = await Promise.all([
      prisma.authRateLimit.count(),
      prisma.authRateLimit.count({ where: { created_at: { lt: cutoff } } }),
    ]);
    return res.status(200).json({ dryRun: true, retentionMinutes: RATE_LIMIT_RETENTION_MINUTES, cutoff: cutoff.toISOString(), total, wouldDelete: stale });
  }

  const { deleted } = await reapRateLimits();
  const remaining = await prisma.authRateLimit.count();
  return res.status(200).json({ ok: true, retentionMinutes: RATE_LIMIT_RETENTION_MINUTES, cutoff: cutoff.toISOString(), deleted, remaining });
}
