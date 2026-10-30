/**
 * File: pages/api/cron/operator-alerts.ts
 * HOURLY. The owner's alerts that cannot be fired by the thing they are about, plus a catch-up.
 *
 * Authenticated by CRON_SECRET (Bearer), not a session — Vercel Cron sends the header when the env
 * var is set, and a manual call with the secret is fine because every send is idempotent.
 *
 * ── WHY THIS EXISTS AT ALL, WHEN THREE OF THE FOUR ALERTS FIRE INLINE ──────────────────────────
 * "Registered an hour ago and never reached checkout" is a statement about time passing, so no
 * request can raise it. And because the inline sends are deliberately non-blocking — a signup must
 * never fail over an email to us — something has to be allowed to notice that one did not go. That
 * is this: it re-walks a seven-day window, and the idempotency in lib/operator-alerts means every
 * alert already settled costs one query and sends nothing.
 *
 * It returns 200 with a tally even when individual sends failed. The failures are IN the tally and
 * on /superadmin/billing; a 500 here would make Vercel retry the whole sweep over one bad address.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { prisma } from '@/lib/db';
import { runOperatorAlertSweep } from '@/lib/operator-alerts';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.authorization !== `Bearer ${secret}`) {
    return res.status(401).json({ message: 'Unauthorized.' });
  }
  try {
    const result = await runOperatorAlertSweep(prisma);
    if (result.errors.length) console.error('[cron operator-alerts] sends that did not go:', result.errors.slice(0, 20));
    return res.status(200).json(result);
  } catch (e) {
    // The sweep itself falling over IS a 500 — that is a fault in our code or the database, not a
    // send that did not go, and it should be retried.
    console.error('[cron operator-alerts] sweep failed:', e);
    return res.status(500).json({ message: 'Sweep failed.' });
  }
}
