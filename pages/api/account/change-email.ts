/**
 * File: pages/api/account/change-email.ts
 * Change the logged-in user's OWN login email — a credential change, guarded like account-takeover.
 * Sibling of account/change-password: self-only (reads the session user id; takes no target id, so a
 * user can never change anyone else's here), re-auth by CURRENT PASSWORD, then an immediate change.
 *
 * PATTERN CHOICE (flagged): the operator side (operator-account) does current-password + immediate
 * change + notify-old, with NO verify-new (confirm-at-new-address) and NO audit. There is no
 * verify-new flow anywhere to reuse — it's a larger lift (a pending_email column + token + a confirm
 * route). So this reuses the simpler operator pattern and ADDS the audit row that was the gap:
 *   • current password required (bcrypt.compare) — the takeover guard,
 *   • uniqueness enforced (User.email is @unique; P2002 → 409),
 *   • the OLD address is notified (a login change must never be silent),
 *   • an AuditLog row is written (who, from → to, when),
 *   • sessions are NOT revoked — unlike change-password, the caller's existing session stays valid as
 *     a backstop so a mistyped new address can't lock you out; the new address works at next sign-in.
 * Only tenant User is touched — Operator and Rep are separate tables/classes, untouched.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/pages/api/auth/[...nextauth]';
import * as bcrypt from 'bcryptjs';
import { writeUserAudit } from '@/lib/audit';
import { sendEmail } from '@/lib/email-service';

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).json({ message: 'Method Not Allowed' }); }
  const session = await getServerSession(req, res, authOptions);
  const sUser = session?.user as any;
  if (!sUser?.id || !sUser?.group_id) return res.status(401).json({ message: 'Not authenticated.' });

  const { newEmail, currentPassword } = (req.body || {}) as { newEmail?: string; currentPassword?: string };
  const email = String(newEmail ?? '').trim().toLowerCase();
  if (!currentPassword) return res.status(400).json({ message: 'Your current password is required.' });
  if (!EMAIL_RE.test(email) || email.length > 200) return res.status(400).json({ message: 'Enter a valid email address.' });

  const me = await prisma.user.findUnique({ where: { id: sUser.id }, select: { email: true, passwordHash: true, group_id: true } });
  if (!me || !me.passwordHash || me.passwordHash === 'INVITE_PENDING') return res.status(400).json({ message: 'Current password is incorrect.' });
  if (!(await bcrypt.compare(currentPassword, me.passwordHash))) return res.status(400).json({ message: 'Current password is incorrect.' });
  if (email === me.email) return res.status(200).json({ ok: true, message: 'That is already your email.', email });

  const oldEmail = me.email;
  try {
    await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      await tx.user.update({ where: { id: sUser.id }, data: { email } });
      // Audit the credential change — the gap this slice closes. from/to recorded on the user entity.
      await writeUserAudit(tx, {
        groupId: me.group_id, actorUserId: sUser.id, targetUserId: sUser.id,
        action: 'user.email_changed', diff: { from: oldEmail, to: email },
      });
    });
  } catch (e: any) {
    if (e?.code === 'P2002') return res.status(409).json({ message: 'That email is already in use by another account.' });
    throw e;
  }

  // Notify the OLD address (best-effort) — a change to the login identity must never be silent.
  sendEmail(oldEmail, 'Your GreaseDesk login email was changed',
    `<p>The login email on your GreaseDesk account was changed to <strong>${email}</strong>.</p>` +
    `<p>If this was you, no action is needed — sign in with the new address from now on. If it wasn't, contact your administrator immediately.</p>`,
  ).catch(() => {});

  // Session stays valid (backstop). Tell the client it may silently re-mint onto the new identity.
  return res.status(200).json({ ok: true, message: 'Login email changed.', email, reauth: true });
}
