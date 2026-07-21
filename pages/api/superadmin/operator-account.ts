/**
 * File: pages/api/superadmin/operator-account.ts
 * OPERATOR SELF-ACCOUNT. The logged-in operator edits their OWN record only — name, email, password.
 * It reads the actor from the session (requireOperatorApi, ANY operator) and writes to actor.userId;
 * it takes no target id, so an operator can never edit anyone else here. Role/region changes and
 * suspend live on the owner-only Operators screen, deliberately not here.
 *
 * PATCH { action: 'name' | 'email' | 'password', ... }.
 *  • name     { name }
 *  • email    { email, currentPassword } — current password required (identity change). Simple version:
 *             change directly + NOTIFY the OLD address. There is NO verify-new/notify-old two-step
 *             pattern for tenants to mirror (only change-password exists), so full new-address
 *             confirmation is deliberately NOT built — flagged for later.
 *  • password { currentPassword, newPassword, confirmPassword } — mirrors the tenant change-password.
 *             (Note: operators have no sessions_valid_from floor, so this does not revoke OTHER operator
 *             sessions; the JWT is id-based, so the caller stays signed in.)
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import * as bcrypt from 'bcryptjs';
import { prisma } from '@/lib/db';
import { requireOperatorApi } from '@/lib/operator-auth';
import { sendEmail } from '@/lib/email-service';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MIN = 8;

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'PATCH') { res.setHeader('Allow', 'PATCH'); return res.status(405).json({ message: 'Method Not Allowed' }); }
  const actor = await requireOperatorApi(req, res); // any operator; wrong class → 404
  if (!actor) return;
  const me = await prisma.operator.findUnique({ where: { id: actor.userId }, select: { id: true, email: true, name: true, passwordHash: true } });
  if (!me) return res.status(404).json({ message: 'Not found.' });

  const b = (req.body || {}) as any;

  if (b.action === 'name') {
    const name = String(b.name ?? '').trim();
    if (!name) return res.status(400).json({ message: 'Enter a name.' });
    await prisma.operator.update({ where: { id: me.id }, data: { name } });
    return res.status(200).json({ ok: true, message: 'Name updated.', name });
  }

  if (b.action === 'email') {
    const email = String(b.email ?? '').trim().toLowerCase();
    const currentPassword = String(b.currentPassword ?? '');
    if (!EMAIL_RE.test(email) || email.length > 200) return res.status(400).json({ message: 'Enter a valid email.' });
    if (!me.passwordHash || me.passwordHash === 'INVITE_PENDING' || !(await bcrypt.compare(currentPassword, me.passwordHash))) {
      return res.status(400).json({ message: 'Current password is incorrect.' });
    }
    if (email === me.email) return res.status(200).json({ ok: true, message: 'No change.' });
    try {
      await prisma.operator.update({ where: { id: me.id }, data: { email } });
    } catch (e: any) {
      if (e?.code === 'P2002') return res.status(409).json({ message: 'That email is already in use.' });
      throw e;
    }
    // NOTIFY the OLD address (best-effort) — a change to the identity anchor should never be silent.
    sendEmail(me.email, 'Your Engine Room email was changed',
      `<p>The email on your GreaseDesk Engine Room account was changed to <strong>${email}</strong>. If this wasn't you, contact the platform owner immediately.</p>`).catch(() => {});
    return res.status(200).json({ ok: true, message: 'Email updated.', email });
  }

  if (b.action === 'password') {
    const { currentPassword, newPassword, confirmPassword } = b as { currentPassword?: string; newPassword?: string; confirmPassword?: string };
    if (!currentPassword || !newPassword || !confirmPassword) return res.status(400).json({ message: 'All fields are required.' });
    if (newPassword !== confirmPassword) return res.status(400).json({ message: 'New password and confirmation do not match.' });
    if (newPassword.length < MIN) return res.status(400).json({ message: `New password must be at least ${MIN} characters.` });
    if (!me.passwordHash || me.passwordHash === 'INVITE_PENDING' || !(await bcrypt.compare(currentPassword, me.passwordHash))) {
      return res.status(400).json({ message: 'Current password is incorrect.' });
    }
    await prisma.operator.update({ where: { id: me.id }, data: { passwordHash: await bcrypt.hash(newPassword, 12) } });
    return res.status(200).json({ ok: true, message: 'Password changed.' });
  }

  return res.status(400).json({ message: 'Unknown action.' });
}
