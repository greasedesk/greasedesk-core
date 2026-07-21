/**
 * File: pages/api/superadmin/operator-set-password.ts
 * Consume a single-use operator invite token and set the operator's password. PUBLIC (no session) —
 * the token IS the credential. Mirrors pages/api/auth/set-password.ts but for the Operator identity.
 * Re-validates server-side (invalid / expired / already-used each refused); single-use enforced in a
 * transaction. On success the operator can sign in at er.greasedesk.com/superadmin/login.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { prisma } from '@/lib/db';
import * as bcrypt from 'bcryptjs';
import { Prisma } from '@prisma/client';
import { hashToken } from '@/lib/tokens';

const MIN_LENGTH = 8;

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).json({ message: 'Method Not Allowed' }); }
  const { token, newPassword, confirmPassword } = (req.body || {}) as { token?: string; newPassword?: string; confirmPassword?: string };
  if (!token) return res.status(400).json({ message: 'This link is invalid.' });
  if (!newPassword || !confirmPassword) return res.status(400).json({ message: 'Enter and confirm a password.' });
  if (newPassword !== confirmPassword) return res.status(400).json({ message: 'Passwords do not match.' });
  if (newPassword.length < MIN_LENGTH) return res.status(400).json({ message: `Password must be at least ${MIN_LENGTH} characters.` });

  const op = await prisma.operator.findFirst({
    where: { invite_token_hash: hashToken(token) },
    select: { id: true, email: true, status: true, invite_token_expires: true, invite_token_used_at: true },
  });
  if (!op) return res.status(400).json({ message: 'This link is invalid.' });
  if (op.status !== 'active') return res.status(403).json({ message: 'This account is not active.' });
  if (op.invite_token_used_at) return res.status(409).json({ message: 'This link has already been used. Please sign in.' });
  if (!op.invite_token_expires || new Date() > new Date(op.invite_token_expires)) {
    return res.status(410).json({ message: 'This link has expired. Ask the platform owner to resend it.' });
  }

  const passwordHash = await bcrypt.hash(newPassword, 12); // house standard, same as every other route
  try {
    await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      const fresh = await tx.operator.findFirst({ where: { id: op.id, invite_token_used_at: null }, select: { id: true } });
      if (!fresh) throw new Error('ALREADY_USED');
      await tx.operator.update({ where: { id: op.id }, data: { passwordHash, invite_token_used_at: new Date() } });
    });
  } catch (e: any) {
    if (e?.message === 'ALREADY_USED') return res.status(409).json({ message: 'This link has already been used. Please sign in.' });
    console.error('operator set-password error:', e);
    return res.status(500).json({ message: 'Could not set your password. Please try again.' });
  }
  return res.status(200).json({ message: 'Password set.', email: op.email });
}
