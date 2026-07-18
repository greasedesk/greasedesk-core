/**
 * File: pages/api/auth/forgot-password.ts
 * Request a password-reset link. POST { email }.
 *
 * ENUMERATION-SAFE (binding): the response body, status AND duration are identical whether or not
 * the address is registered, and whether or not the request was rate-limited. It never confirms an
 * account exists. The only observable difference is the email that does or doesn't arrive.
 *
 * Rate limited per-address AND per-IP via lib/auth-rate-limit (DB-backed — serverless has no usable
 * in-memory state). A limited request returns the SAME response; it simply doesn't send.
 * Token: 1 hour, high-entropy, stored SHA-256-hashed only. Sent from the role no-reply address.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { prisma } from '@/lib/db';
import { makeResetToken } from '@/lib/tokens';
import { sendEmail } from '@/lib/email-service';
import { LIMITS, emailKey, ipKey, takeToken, clientIp, constantTime } from '@/lib/auth-rate-limit';
import { COMPANY } from '@/lib/company-info';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const FLOOR_MS = 700; // constant-time floor — flattens the exists / doesn't-exist timing difference
// ONE response for every outcome. Do not branch this message.
const SAME = { ok: true, message: 'If that address is registered, we’ve sent a link.' };

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).json({ ok: false, message: 'Method Not Allowed' }); }
  const startedAt = Date.now();
  const email = String((req.body || {}).email ?? '').trim().toLowerCase();

  // Malformed input still gets the identical answer — a validation error would itself be a signal.
  if (!EMAIL_RE.test(email) || email.length > 200) return res.status(200).json(await constantTime(startedAt, FLOOR_MS, SAME));

  const okIp = await takeToken(ipKey(clientIp(req.headers)), LIMITS.perIp.max, LIMITS.perIp.windowMinutes);
  const okEmail = await takeToken(emailKey(email), LIMITS.perEmail.max, LIMITS.perEmail.windowMinutes);
  if (!okIp || !okEmail) return res.status(200).json(await constantTime(startedAt, FLOOR_MS, SAME));

  try {
    const user = await prisma.user.findUnique({ where: { email }, select: { id: true, is_active: true } });
    if (user && user.is_active) {
      const t = makeResetToken();
      await prisma.user.update({
        where: { id: user.id },
        data: { reset_token_hash: t.hash, reset_token_expires: t.expires },
      });
      const base = process.env.NEXTAUTH_URL || COMPANY.siteUrl;
      const link = `${base}/reset-password?token=${t.raw}`;
      await sendEmail(
        email,
        'Reset your GreaseDesk password',
        `<h2>Reset your password</h2>
         <p>We received a request to reset the password for your GreaseDesk account.</p>
         <p><a href="${link}">Set a new password</a></p>
         <p>This link expires in 1 hour and can be used once. If you didn’t ask for this, you can ignore
            this email — your password hasn’t changed.</p>`,
        { fromName: 'GreaseDesk' }, // role no-reply From (EMAIL_FROM) — never a personal address
      );
    }
  } catch (e) {
    console.error('[forgot-password] failed', e); // never surfaced — the response must not vary
  }
  return res.status(200).json(await constantTime(startedAt, FLOOR_MS, SAME));
}
