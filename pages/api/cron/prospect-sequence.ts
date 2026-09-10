/**
 * File: pages/api/cron/prospect-sequence.ts
 * THE PROSPECT FOLLOW-UP, ON A SCHEDULE — sends every due step, and applies the 24-month retention
 * rule. CRON_SECRET-guarded, like every other job here.
 *
 * Hourly. The FIRST email of a sequence does not wait for this — it goes the moment the rep records
 * the address (lib/prospect-store::recordVisit). This picks up everything after it, and retries any
 * step that could not be sent: a step that did not go is left due, never skipped as if it had.
 *
 * RETENTION RUNS HERE TOO, so the rule is applied rather than merely stated. Nothing on the live
 * system is old enough to trigger it on 2026-09-10; it is built now because a retention rule with no
 * implementation is a policy nobody applies.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { runSequence, sweepRetention } from '@/lib/prospect-store';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.authorization !== `Bearer ${secret}`) return res.status(401).json({ message: 'Unauthorized.' });
  const now = new Date();
  const sequence = await runSequence({ now });
  const stripped = await sweepRetention(now);
  return res.status(200).json({ ok: true, sequence, retentionStripped: stripped });
}
