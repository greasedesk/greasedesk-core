/**
 * File: pages/api/cron/confirm-paid.ts
 * Hourly Vercel Cron entry point for the clearance sweep (see lib/confirm-paid.ts — claim-first,
 * idempotent, one send path). Authenticated by CRON_SECRET (Bearer), NOT a session — Vercel Cron
 * sends the header automatically when the env var is set. Manual invocation with the secret is
 * fine (idempotent by design).
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { runConfirmPaidSweep } from '@/lib/confirm-paid';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.authorization !== `Bearer ${secret}`) {
    return res.status(401).json({ message: 'Unauthorized.' });
  }
  try {
    const result = await runConfirmPaidSweep();
    return res.status(200).json(result);
  } catch (e) {
    console.error('[cron confirm-paid] sweep failed:', e);
    return res.status(500).json({ message: 'Sweep failed.' });
  }
}
