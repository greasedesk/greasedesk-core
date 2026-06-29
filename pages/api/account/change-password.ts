/**
 * File: pages/api/account/change-password.ts
 * Change the logged-in user's own password. Verifies the current password against the stored
 * bcrypt hash (bcryptjs, same lib as login), then stores a new bcrypt hash.
 * Logged-in change only — no tokens, no email (forgot-password is a later slice).
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { prisma } from '@/lib/db';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/pages/api/auth/[...nextauth]';
import * as bcrypt from 'bcryptjs';

const MIN_LENGTH = 8;

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ message: 'Method Not Allowed' });
  }
  const session = await getServerSession(req, res, authOptions);
  const sUser = session?.user as any;
  if (!sUser?.id) return res.status(401).json({ message: 'Not authenticated.' });

  const { currentPassword, newPassword, confirmPassword } = (req.body || {}) as {
    currentPassword?: string; newPassword?: string; confirmPassword?: string;
  };
  if (!currentPassword || !newPassword || !confirmPassword) {
    return res.status(400).json({ message: 'All fields are required.' });
  }
  if (newPassword !== confirmPassword) {
    return res.status(400).json({ message: 'New password and confirmation do not match.' });
  }
  if (newPassword.length < MIN_LENGTH) {
    return res.status(400).json({ message: `New password must be at least ${MIN_LENGTH} characters.` });
  }

  const user = await prisma.user.findUnique({ where: { id: sUser.id }, select: { passwordHash: true } });
  if (!user || !user.passwordHash || user.passwordHash === 'INVITE_PENDING') {
    // Shouldn't happen for a logged-in user, but never crash.
    return res.status(400).json({ message: 'Current password is incorrect.' });
  }

  const ok = await bcrypt.compare(currentPassword, user.passwordHash);
  if (!ok) return res.status(400).json({ message: 'Current password is incorrect.' });

  const newHash = await bcrypt.hash(newPassword, 10);
  await prisma.user.update({ where: { id: sUser.id }, data: { passwordHash: newHash } });

  return res.status(200).json({ message: 'Password changed.' });
}
