/**
 * File: pages/api/auth/set-password.ts
 * Consume a single-use invite token and set the user's password. Public (no session) — the
 * token IS the credential. Re-validates the token server-side (never trusts the landing page):
 * invalid / expired / already-used are each refused with a clear, non-crashing message.
 * On success: set bcrypt passwordHash, activate the user, consume the token (single-use).
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { prisma } from '@/lib/db';
import * as bcrypt from 'bcryptjs';
import { Prisma } from '@prisma/client';
import { hashToken } from '@/lib/tokens';

const MIN_LENGTH = 8;

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ message: 'Method Not Allowed' });
  }
  const { token, newPassword, confirmPassword } = (req.body || {}) as {
    token?: string; newPassword?: string; confirmPassword?: string;
  };
  if (!token) return res.status(400).json({ message: 'This invite link is invalid.' });
  if (!newPassword || !confirmPassword) return res.status(400).json({ message: 'Enter and confirm a password.' });
  if (newPassword !== confirmPassword) return res.status(400).json({ message: 'Passwords do not match.' });
  if (newPassword.length < MIN_LENGTH) return res.status(400).json({ message: `Password must be at least ${MIN_LENGTH} characters.` });

  const user = await prisma.user.findFirst({
    where: { invite_token_hash: hashToken(token) },
    select: { id: true, email: true, invite_token_expires: true, invite_token_used_at: true },
  });
  if (!user) return res.status(400).json({ message: 'This invite link is invalid.' });
  if (user.invite_token_used_at) return res.status(409).json({ message: 'This invite has already been used. Please log in.' });
  if (!user.invite_token_expires || new Date() > new Date(user.invite_token_expires)) {
    return res.status(410).json({ message: 'This invite link has expired. Ask your admin to resend it.' });
  }

  const passwordHash = await bcrypt.hash(newPassword, 10);
  try {
    await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      // Re-read inside the tx and guard again, so two concurrent submits can't both consume it.
      const fresh = await tx.user.findFirst({ where: { id: user.id, invite_token_used_at: null }, select: { id: true } });
      if (!fresh) throw new Error('ALREADY_USED');
      await tx.user.update({
        where: { id: user.id },
        data: { passwordHash, is_active: true, invite_token_used_at: new Date() },
      });
    });
  } catch (e: any) {
    if (e?.message === 'ALREADY_USED') {
      return res.status(409).json({ message: 'This invite has already been used. Please log in.' });
    }
    console.error('set-password error:', e);
    return res.status(500).json({ message: 'Could not set your password. Please try again.' });
  }

  // Return the email so the landing page can auto-sign-in with the new password.
  return res.status(200).json({ message: 'Password set.', email: user.email });
}
