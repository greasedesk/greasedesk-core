/**
 * File: pages/api/superadmin/2fa-preflight.ts
 * LOGIN UX ONLY — tells the operator login form whether to show the authenticator-code field, so the
 * user isn't left guessing. Returns twoFactorRequired=true ONLY when the password is correct AND 2FA
 * is enabled; otherwise false (covers wrong password and no-2FA alike, so it leaks nothing to someone
 * who doesn't already hold the password / first factor).
 *
 * This is NOT the enforcement point — the operator authorize() independently requires the code when
 * 2FA is enabled, so skipping this preflight cannot bypass 2FA. It issues no session and no cookie.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import * as bcrypt from 'bcryptjs';
import { prisma } from '@/lib/db';
import { isEnabled } from '@/lib/two-factor';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).json({ message: 'Method Not Allowed' }); }
  const { email, password } = (req.body || {}) as { email?: string; password?: string };
  if (!email || !password) return res.status(200).json({ twoFactorRequired: false });

  const op = await prisma.operator.findUnique({ where: { email: String(email) }, select: { id: true, status: true, passwordHash: true } });
  const passwordOk = !!op && op.status === 'active' && !!op.passwordHash && op.passwordHash !== 'INVITE_PENDING' && (await bcrypt.compare(String(password), op.passwordHash));
  const twoFactorRequired = passwordOk && (await isEnabled({ type: 'operator', id: op!.id }));
  return res.status(200).json({ twoFactorRequired });
}
