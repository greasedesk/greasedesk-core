/**
 * File: pages/api/cron/inbound-bodies.ts
 * Hourly retry of inbound bodies that did not arrive with their message (see lib/inbound-body-sweep).
 * CRON_SECRET (Bearer), not a session — same as the clearance sweep. Idempotent: a row that already
 * has a body is not a candidate.
 *
 * It runs HERE, in production, deliberately: this is the only environment holding a working
 * RESEND_API_KEY, so it is the only place that can say whether a body fetch fails because the key
 * lacks receiving access or because the content was not ready yet.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { prisma } from '@/lib/db';
import { runInboundBodySweep } from '@/lib/inbound-body-sweep';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.authorization !== `Bearer ${secret}`) return res.status(401).json({ message: 'Unauthorized.' });
  try {
    const result = await runInboundBodySweep(prisma);
    console.log('[cron inbound-bodies]', JSON.stringify(result));
    return res.status(200).json(result);
  } catch (e: any) {
    console.error('[cron inbound-bodies] failed:', e?.message);
    return res.status(500).json({ message: 'Sweep failed.' });
  }
}
