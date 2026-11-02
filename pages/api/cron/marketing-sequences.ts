/**
 * File: pages/api/cron/marketing-sequences.ts
 * EVERY MARKETING SEQUENCE'S DUE STEPS, ON A SCHEDULE — and the prospect retention rule, which runs
 * here because it always did. CRON_SECRET-guarded, like every other job here.
 *
 * Replaces pages/api/cron/prospect-sequence.ts. One job for all four sequences, not four jobs: the
 * reason the engine was generalised was that four copies of this would drift, and four cron entries
 * is where that drift would start.
 *
 * Hourly. The FIRST email of a sequence does not wait for this — it goes the moment the enrolment is
 * created (lib/prospect-store::recordVisit does it for a garage prospect, and each audience's own
 * hook does the same). This picks up everything after it, and retries any step that could not be
 * sent: a step that did not go is left due, never skipped as if it had.
 *
 * ── A SEQUENCE THAT IS OFF STILL APPEARS IN THE OUTPUT ─────────────────────────────────────────
 * With `sending: 'off'` and the number it held. A run that sent nothing must say which of the two
 * reasons it is — nothing was due, or everything due was held — because those look identical from
 * outside and only one of them is a problem.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { runSequences } from '@/lib/marketing-store';
import { sweepRetention } from '@/lib/prospect-store';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.authorization !== `Bearer ${secret}`) return res.status(401).json({ message: 'Unauthorized.' });
  const now = new Date();
  const sequences = await runSequences({ now });
  const stripped = await sweepRetention(now);
  return res.status(200).json({ ok: true, sequences, retentionStripped: stripped });
}
