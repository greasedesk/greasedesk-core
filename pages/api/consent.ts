/**
 * File: pages/api/consent.ts
 * Record a cookie-consent choice as a versioned, auditable event (ConsentEvent). Public + anonymous
 * (the choice is made on the pre-login marketing site) — NO PII stored, only the browser's stable
 * consent_id (which also lives in the gd_consent cookie), the policy version + region in force, and the
 * per-category choice. A changed choice writes a new row with the same consent_id → the trail is the
 * history. This is the "what did they consent to, and when" record a regulator/user may ask for.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { prisma } from '@/lib/db';
import { POLICY_VERSION } from '@/lib/consent';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).json({ ok: false }); }

  const b = (req.body || {}) as { id?: string; v?: string; region?: string; choice?: { functional?: unknown; analytics?: unknown; marketing?: unknown } };
  const consentId = String(b.id ?? '').slice(0, 64);
  const choice = b.choice || {};
  if (!consentId || !b.choice || typeof b.choice !== 'object') return res.status(400).json({ ok: false, message: 'Bad request.' });

  await prisma.consentEvent.create({
    data: {
      consent_id: consentId,
      policy_version: String(b.v ?? POLICY_VERSION).slice(0, 32),
      region: String(b.region ?? 'GB').slice(0, 8),
      functional: !!choice.functional,
      analytics: !!choice.analytics,
      marketing: !!choice.marketing,
    },
  });
  return res.status(200).json({ ok: true });
}
