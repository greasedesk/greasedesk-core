/**
 * File: pages/api/superadmin/2fa.ts
 * Operator SELF-service 2FA — acts on the logged-in operator's OWN account only (reads actor.userId;
 * no target id). requireOperatorApi (any operator; wrong class → 404). All state changes audited.
 *
 *   GET                      → status { enabled, pending, recoveryRemaining }
 *   POST { action:'enrol' }  → begin enrolment: { secret, otpauthUri, qrDataUri } (2FA NOT yet on)
 *   POST { action:'confirm', code }             → verify the code, enable, return recovery codes ONCE
 *   POST { action:'disable', password, code }   → password + a valid TOTP/recovery code, then turn off
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import * as bcrypt from 'bcryptjs';
import QRCode from 'qrcode';
import { prisma } from '@/lib/db';
import { requireOperatorApi } from '@/lib/operator-auth';
import { beginEnrolment, confirmEnrolment, disable, isEnabled, status, verifySecondFactor } from '@/lib/two-factor';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  res.setHeader('Cache-Control', 'no-store');
  const actor = await requireOperatorApi(req, res); // any operator; wrong class → 404
  if (!actor) return;
  const me = await prisma.operator.findUnique({ where: { id: actor.userId }, select: { id: true, email: true, passwordHash: true } });
  if (!me) return res.status(404).json({ message: 'Not found.' });
  const subject = { type: 'operator' as const, id: me.id };

  if (req.method === 'GET') {
    return res.status(200).json(await status(subject));
  }

  if (req.method === 'POST') {
    const b = (req.body || {}) as { action?: string; code?: string; password?: string };

    if (b.action === 'enrol') {
      let secret, otpauthUri;
      try { ({ secret, otpauthUri } = await beginEnrolment(subject, me.email)); }
      catch (e: any) { return res.status(409).json({ message: e?.message || 'Cannot enrol.' }); }
      const qrDataUri = await QRCode.toDataURL(otpauthUri, { margin: 1, width: 220 });
      return res.status(200).json({ ok: true, secret, otpauthUri, qrDataUri });
    }

    if (b.action === 'confirm') {
      const code = String(b.code ?? '').trim();
      const result = await confirmEnrolment(subject, code);
      if (!result) return res.status(400).json({ message: 'That code did not match. 2FA is not enabled — scan the QR again and enter a fresh code.' });
      await audit(me.id, 'operator.2fa_enrolled', me.email);
      return res.status(200).json({ ok: true, recoveryCodes: result.recoveryCodes, message: 'Two-factor authentication is on. Save your recovery codes now — they are shown only once.' });
    }

    if (b.action === 'disable') {
      if (!(await isEnabled(subject))) return res.status(200).json({ ok: true, message: '2FA is already off.' });
      const password = String(b.password ?? '');
      const code = String(b.code ?? '').trim();
      if (!me.passwordHash || !(await bcrypt.compare(password, me.passwordHash))) return res.status(400).json({ message: 'Current password is incorrect.' });
      const v = await verifySecondFactor(subject, code);
      if (!v.ok) return res.status(400).json({ message: 'Enter a valid authenticator or recovery code to turn 2FA off.' });
      await disable(subject);
      await audit(me.id, 'operator.2fa_disabled', me.email);
      return res.status(200).json({ ok: true, message: 'Two-factor authentication disabled.' });
    }

    return res.status(400).json({ message: 'Unknown action.' });
  }

  res.setHeader('Allow', 'GET, POST');
  return res.status(405).json({ message: 'Method Not Allowed' });
}

async function audit(operatorId: string, action: string, email: string) {
  await prisma.superAdminAudit.create({ data: {
    operator_user_id: operatorId, action, target_group_id: null, target_operator_id: null, target_name_snapshot: email,
  } }).catch(() => {});
}
