/**
 * File: pages/api/auth/reset-password.ts
 * Consume a reset token and set a new password. POST { token, newPassword, confirmPassword }.
 * Public (no session) — the token IS the credential; re-validated server-side, never trusted from
 * the landing page.
 *
 * On success, in ONE transaction:
 *   - bcrypt the new password,
 *   - CONSUME the token (null the hash + expiry — single use),
 *   - set sessions_valid_from = now() → every JWT issued before this instant is dead (see the
 *     jwt callback in [...nextauth]). A stolen 90-day /m session cannot survive a reset.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import bcrypt from 'bcryptjs';
import { prisma } from '@/lib/db';
import { hashToken } from '@/lib/tokens';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).json({ message: 'Method Not Allowed' }); }
  const { token, newPassword, confirmPassword } = (req.body || {}) as { token?: string; newPassword?: string; confirmPassword?: string };

  if (!token) return res.status(400).json({ message: 'This reset link is invalid.' });
  if (!newPassword || newPassword.length < 8) return res.status(400).json({ message: 'Password must be at least 8 characters long.' });
  if (newPassword !== confirmPassword) return res.status(400).json({ message: 'Those passwords don’t match.' });

  const user = await prisma.user.findFirst({
    where: { reset_token_hash: hashToken(token) },
    select: { id: true, email: true, reset_token_expires: true, is_active: true },
  });
  // Expired / already-consumed / unknown all read the same: ask for a fresh link.
  if (!user || !user.reset_token_expires || new Date() > new Date(user.reset_token_expires)) {
    return res.status(400).json({ message: 'This reset link has expired or already been used. Please request a new one.' });
  }
  // A DEACTIVATED account may not be resurrected by completing a reset. forgot-password already
  // declines to ISSUE a link to an inactive user, but that is a side effect of a different check —
  // it would not stop a link minted before the account was suspended. This is the explicit control.
  // Same generic message: never confirm to a stranger that the account exists but is suspended.
  if (!user.is_active) {
    return res.status(400).json({ message: 'This reset link has expired or already been used. Please request a new one.' });
  }

  const passwordHash = await bcrypt.hash(newPassword, 12);
  await prisma.user.update({
    where: { id: user.id },
    data: {
      passwordHash,
      reset_token_hash: null,      // single use — consumed
      reset_token_expires: null,
      sessions_valid_from: new Date(), // kill every session issued before now
      // is_active is deliberately NOT touched here. A reset changes CREDENTIALS, never account
      // status — the old `is_active: true` silently un-suspended a deactivated account. Reaching
      // this line already means the account was active (guarded above), so there was nothing to set.
    },
  });

  return res.status(200).json({ ok: true, email: user.email, message: 'Password updated. You can sign in now.' });
}
