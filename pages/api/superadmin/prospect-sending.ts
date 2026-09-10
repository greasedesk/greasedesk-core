/**
 * File: pages/api/superadmin/prospect-sending.ts
 * POST { enabled } — switch GreaseDesk's prospect follow-up emails on or off. OWNER ONLY.
 *
 * Owner-only for the same reason the screen is: turning this on emails real people, on copy that is
 * placeholder until the owner writes it. Audited in lib/prospect-store::setProspectSending — who
 * switched it, when, and how many sequences were waiting at that moment.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { requireOperatorApi } from '@/lib/operator-auth';
import { setProspectSending, prospectSendingState } from '@/lib/prospect-store';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).end(); }
  const op = await requireOperatorApi(req, res, { minRole: 'owner' });
  if (!op) return;
  // AN EXPLICIT BOOLEAN ONLY. Anything else is refused rather than coerced — "switch on" must never be
  // the accidental reading of a malformed request.
  if (typeof req.body?.enabled !== 'boolean') return res.status(400).json({ message: 'Say whether sending should be on or off.' });
  await setProspectSending({ enabled: req.body.enabled, operatorId: op.userId });
  return res.status(200).json(await prospectSendingState());
}
