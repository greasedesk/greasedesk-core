/**
 * File: pages/api/account/2fa.ts
 * TENANT SELF-service 2FA — acts on the logged-in user's OWN account only. Never takes a target id,
 * because there is no legitimate reason for one: enrolment requires proving possession of the
 * authenticator, so nobody can enrol on anybody else's behalf. An ADMIN wanting to help a colleague
 * gets exactly one power, on a different route (settings/users → reset), and it DISABLES.
 *
 *   GET                                        → status { enabled, pending, recoveryRemaining }
 *   POST { action:'enrol' }                    → { secret, otpauthUri, qrDataUri } — 2FA NOT yet on
 *   POST { action:'confirm', code }            → verify, enable, return recovery codes ONCE
 *   POST { action:'disable', password, code }  → password AND a valid code, then turn off
 *
 * The mirror of pages/api/superadmin/2fa.ts, over the same lib/two-factor lifecycle with a different
 * subject_type. The rules are the chokepoint's; this is only the surface.
 *
 * DISABLE NEEDS BOTH FACTORS. Turning 2FA off is exactly what an attacker holding a stolen session
 * would do first, so it re-asks for the password AND a live code — the one place we deliberately
 * make a logged-in user prove themselves again.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import * as bcrypt from 'bcryptjs';
import QRCode from 'qrcode';
import { prisma } from '@/lib/db';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/pages/api/auth/[...nextauth]';
import { beginEnrolment, confirmEnrolment, disable, isEnabled, status, verifySecondFactor } from '@/lib/two-factor';
import { writeUserAudit } from '@/lib/audit';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  res.setHeader('Cache-Control', 'no-store');
  const session = await getServerSession(req, res, authOptions);
  const u = session?.user as any;
  // actorClass guard: an operator or rep session must not reach the tenant subject space, or the
  // two identity systems would share a row keyed by ids from different tables.
  if (!u?.id || !u?.group_id || (u.actorClass && u.actorClass !== 'tenant')) {
    return res.status(401).json({ message: 'Not authenticated.' });
  }

  const me = await prisma.user.findUnique({
    where: { id: u.id as string },
    select: { id: true, email: true, passwordHash: true, group_id: true, is_active: true },
  });
  if (!me || !me.is_active) return res.status(401).json({ message: 'Not authenticated.' });

  const subject = { type: 'tenant' as const, id: me.id };
  // actor === target: the user is acting on their own account, which is the only shape this route has.
  const audit = (action: 'user.2fa_enrolled' | 'user.2fa_disabled') =>
    writeUserAudit(prisma, { groupId: me.group_id as string, actorUserId: me.id, targetUserId: me.id, action }).catch(() => {});

  if (req.method === 'GET') return res.status(200).json(await status(subject));

  if (req.method === 'POST') {
    const b = (req.body || {}) as { action?: string; code?: string; password?: string };

    if (b.action === 'enrol') {
      let secret: string, otpauthUri: string;
      try { ({ secret, otpauthUri } = await beginEnrolment(subject, me.email)); }
      catch (e: any) { return res.status(409).json({ message: e?.message || 'Cannot enrol.' }); }
      const qrDataUri = await QRCode.toDataURL(otpauthUri, { margin: 1, width: 220 });
      // NOT audited: beginning an enrolment changes no security state — `enabled` is still false and
      // the row is overwritable. The audit belongs on the transition that actually protects the
      // account, which is `confirm`.
      return res.status(200).json({ ok: true, secret, otpauthUri, qrDataUri });
    }

    if (b.action === 'confirm') {
      const result = await confirmEnrolment(subject, String(b.code ?? '').trim());
      if (!result) {
        return res.status(400).json({ message: 'That code didn’t match. Two-factor authentication is NOT on — check your phone’s clock is set automatically, then enter a fresh code.' });
      }
      await audit('user.2fa_enrolled');
      return res.status(200).json({
        ok: true,
        recoveryCodes: result.recoveryCodes,
        message: 'Two-factor authentication is on. Save your recovery codes now — they are shown only once.',
      });
    }

    if (b.action === 'disable') {
      if (!(await isEnabled(subject))) return res.status(200).json({ ok: true, message: 'Two-factor authentication is already off.' });
      if (!me.passwordHash || !(await bcrypt.compare(String(b.password ?? ''), me.passwordHash))) {
        return res.status(400).json({ message: 'That password is incorrect.' });
      }
      const v = await verifySecondFactor(subject, String(b.code ?? '').trim());
      if (!v.ok) {
        return res.status(400).json({
          message: v.lockedOut
            ? 'Too many incorrect codes. Wait 15 minutes and try again.'
            : 'Enter a valid authenticator or recovery code to turn two-factor authentication off.',
        });
      }
      await disable(subject);
      await audit('user.2fa_disabled');
      return res.status(200).json({ ok: true, message: 'Two-factor authentication is off.' });
    }

    return res.status(400).json({ message: 'Unknown action.' });
  }

  res.setHeader('Allow', 'GET, POST');
  return res.status(405).json({ message: 'Method Not Allowed' });
}
