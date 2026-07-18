/**
 * File: pages/api/user-sign-out.ts
 * ADMIN-only: sign one user out of every device by stamping the session revocation floor.
 *
 * THE STOLEN-PHONE CASE. A mechanic's handset carries a 90-day /m session; whoever holds the phone
 * holds the access, no password needed. Stamping User.sessions_valid_from kills every token minted
 * before now, so the handset is locked out on its very next request (see the jwt callback in
 * [...nextauth].ts — that comparison is the enforcement; this write is only the signal).
 *
 * What this DOESN'T do: it is not a lockout. Anyone who knows the password can simply sign in
 * again. A known-password compromise needs a reset or deactivation as well — the UI says so.
 *
 * Self-targeting is ALLOWED (the owner's own phone can be the stolen one); the caller's own session
 * dies with it and the client signs them out. Same mechanism, no per-session exemption.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import { requireAdminApi } from '@/lib/admin-guard';
import { writeUserAudit } from '@/lib/audit';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ message: 'Method Not Allowed' });
  }

  const vis = await requireAdminApi(req, res); // sends 401/403 itself
  if (!vis) return;

  const { userId } = (req.body || {}) as { userId?: string };
  if (!userId) return res.status(400).json({ message: 'userId is required.' });
  if (!vis.groupId) return res.status(403).json({ message: 'Admin access required.' });

  // TENANT SCOPE: an admin may only act on a member of their OWN group. A 404 (not 403) so this
  // endpoint can't be used to probe which user ids exist in other tenants.
  const target = await prisma.user.findFirst({
    where: { id: userId, group_id: vis.groupId },
    select: { id: true, email: true, name: true },
  });
  if (!target) return res.status(404).json({ message: 'User not found.' });

  // Write + audit in one transaction: a revocation that isn't recorded, or a record without the
  // revocation, would both be worse than failing.
  await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    await tx.user.update({ where: { id: target.id }, data: { sessions_valid_from: new Date() } });
    await writeUserAudit(tx, {
      groupId: vis.groupId as string,
      actorUserId: vis.userId,
      targetUserId: target.id,
      action: 'user.sessions_revoked',
      diff: { target_email: target.email },
    });
  });

  return res.status(200).json({
    message: 'Signed out everywhere.',
    self: target.id === vis.userId, // the client signs itself out when the admin targeted themselves
  });
}
