/**
 * File: pages/api/superadmin/operator-forgot-password.ts
 * Operator "forgot password" — request a reset link. POST { email }. Mirrors the tenant flow's
 * discipline: ENUMERATION-SAFE (one response for every outcome, constant-time floor, rate-limited),
 * so it never reveals whether an operator with that email exists. On a match it re-mints a set-password
 * token (stored in the same invite_token_* columns the /superadmin/set-password page consumes — a reset
 * is just "set a password via a fresh token") and EMAILS the link. Unlike owner-initiated create, this
 * PUBLIC path never returns the link in the response — surfacing it would be an account-takeover vector.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { prisma } from '@/lib/db';
import { makeResetToken } from '@/lib/tokens';
import { sendEmail } from '@/lib/email-service';
import { LIMITS, emailKey, ipKey, takeToken, clientIp, constantTime } from '@/lib/auth-rate-limit';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const FLOOR_MS = 700; // constant-time floor — flattens the exists / doesn't-exist timing difference
const SAME = { ok: true, message: 'If that operator exists, we’ve sent a reset link.' }; // ONE response — never branch it

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).json({ ok: false, message: 'Method Not Allowed' }); }
  const startedAt = Date.now();
  const email = String((req.body || {}).email ?? '').trim().toLowerCase();
  if (!EMAIL_RE.test(email) || email.length > 200) return res.status(200).json(await constantTime(startedAt, FLOOR_MS, SAME));

  const okIp = await takeToken(ipKey(clientIp(req.headers)), LIMITS.perIp.max, LIMITS.perIp.windowMinutes);
  const okEmail = await takeToken(emailKey(email), LIMITS.perEmail.max, LIMITS.perEmail.windowMinutes);
  if (!okIp || !okEmail) return res.status(200).json(await constantTime(startedAt, FLOOR_MS, SAME));

  try {
    const op = await prisma.operator.findUnique({ where: { email }, select: { id: true, name: true, status: true } });
    if (op && op.status === 'active') {
      const t = makeResetToken(); // 1-hour, single-use
      await prisma.operator.update({ where: { id: op.id }, data: { invite_token_hash: t.hash, invite_token_expires: t.expires, invite_token_used_at: null } });
      const host = req.headers.host || 'er.greasedesk.com';
      const link = `https://${host}/superadmin/set-password?token=${t.raw}`;
      await sendEmail(email, 'Reset your Engine Room password',
        `<p>We received a request to reset your GreaseDesk Engine Room password.</p>` +
        `<p><a href="${link}">Set a new password</a></p><p>This link expires in 1 hour and can be used once. If you didn’t ask for this, ignore this email.</p>`,
      ).catch(() => {});
    }
  } catch { /* fall through to the identical response */ }
  return res.status(200).json(await constantTime(startedAt, FLOOR_MS, SAME));
}
