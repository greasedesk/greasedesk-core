/**
 * File: pages/api/account/2fa-preflight.ts
 * POST { email, password } → { twoFactorRequired } for the TENANT login form.
 *
 * WHY A PREFLIGHT AT ALL. NextAuth's credentials flow is one shot: the form cannot discover that a
 * code is needed except by failing a sign-in, and a failed sign-in is indistinguishable to the user
 * from a wrong password. This answers "will you also want a code?" so the form can ask for it once,
 * rather than telling someone their correct password was rejected. The mirror of
 * pages/api/superadmin/2fa-preflight.ts.
 *
 * IT GRANTS NOTHING. No session, no cookie, no token. It reveals only whether 2FA is on for an
 * account whose password the caller ALREADY HOLDS — which they would learn from the next request
 * anyway. Password wrong → always false, so it can never be used to enumerate who has 2FA enabled.
 * Deliberately not rate-limited beyond that: it is strictly less informative than the login itself.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import * as bcrypt from 'bcryptjs';
import { prisma } from '@/lib/db';
import { isEnabled } from '@/lib/two-factor';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).end(); }
  const { email, password } = (req.body || {}) as { email?: string; password?: string };
  if (!email || !password) return res.status(200).json({ twoFactorRequired: false });

  const user = await prisma.user.findUnique({
    where: { email: String(email) },
    select: { id: true, passwordHash: true, is_active: true },
  });
  const passwordOk = !!user?.is_active
    && !!user.passwordHash
    && user.passwordHash !== 'INVITE_PENDING'
    && (await bcrypt.compare(String(password), user.passwordHash));

  return res.status(200).json({
    twoFactorRequired: passwordOk && (await isEnabled({ type: 'tenant', id: user!.id })),
  });
}
