/**
 * File: pages/api/account/phone.ts
 * The logged-in user's OWN mobile: send a code, confirm it, see the state. Self only — the number is
 * a security destination, and one person must never be able to point another's at their handset.
 *
 *   GET                                → { phone, verified }  (the number is MASKED, see below)
 *   POST { action:'send', phone }      → mint + send a code (all five limits, fail-closed)
 *   POST { action:'confirm', code }    → verify and record it
 *
 * NON-BLOCKING BY DESIGN. Nothing here gates anything: an unverified number is a recorded fact, not
 * a locked door. The signup flow calls the same endpoints and simply lets the user walk away.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { prisma } from '@/lib/db';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/pages/api/auth/[...nextauth]';
import { clientIp } from '@/lib/auth-rate-limit';
import { sendPhoneVerification, confirmPhoneVerification } from '@/lib/phone-verification';
import { liveCodeDestination } from '@/lib/delivered-code';

/** Last three digits only. Enough for "yes, that's my phone", useless to anyone who isn't them. */
const mask = (e164: string | null): string | null => (e164 ? `•••• ••• ${e164.slice(-3)}` : null);

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  res.setHeader('Cache-Control', 'no-store');
  const session = await getServerSession(req, res, authOptions);
  const u = session?.user as any;
  if (!u?.id || !u?.group_id || (u.actorClass && u.actorClass !== 'tenant')) {
    return res.status(401).json({ message: 'Not authenticated.' });
  }
  const subject = { type: 'tenant' as const, id: u.id as string };
  const groupId = u.group_id as string;

  const row = await prisma.twoFactorSecret.findUnique({
    where: { subject_type_subject_id: { subject_type: 'tenant', subject_id: subject.id } },
    select: { phone_e164: true, phone_verified_at: true },
  });

  if (req.method === 'GET') {
    // `pending` is the number a live code was sent to. It can differ from `phone` now that a new
    // number no longer displaces a confirmed one — the surface must be able to say "confirmed this,
    // awaiting confirmation on that" instead of showing one number and meaning two things.
    const pending = await liveCodeDestination(subject, 'phone_verify');
    return res.status(200).json({
      phone: mask(row?.phone_e164 ?? null),
      verified: !!row?.phone_verified_at,
      codeOutstanding: !!pending,
      pendingPhone: mask(pending),
      pendingDiffers: !!pending && !!row?.phone_e164 && pending !== row.phone_e164,
    });
  }

  if (req.method === 'POST') {
    const b = (req.body || {}) as { action?: string; phone?: string; code?: string };

    if (b.action === 'send') {
      const raw = String(b.phone ?? '').trim();
      if (!raw) return res.status(400).json({ code: 'bad_number', message: 'Enter your mobile number.' });
      // NOTE: the route does NOT clear codes. It used to, unconditionally, which silently defeated
      // the resend cooldown — clearing the row removed the timestamp the cooldown is measured from.
      // The rule now lives in sendPhoneVerification, which is the only place that knows whether the
      // number actually changed.
      const country = await prisma.group.findUnique({ where: { id: groupId }, select: { country_code: true } });
      const r = await sendPhoneVerification({
        subject, groupId, rawPhone: raw, ip: clientIp(req.headers as any),
        countryDialCode: dialCodeFor(country?.country_code),
      });
      if (!('ok' in r)) {
        // 503, not 400: an unconfigured provider is OUR state, not bad input from the user, and the
        // status code is the first thing anyone debugging this will read.
        const status = r.code === 'rate_limited' || r.code === 'cooldown' ? 429
          : r.code === 'sms_unavailable' ? 503
          : r.code === 'not_sent' ? 502
          : 400;
        return res.status(status).json(r);
      }
      return res.status(200).json({ ok: true, phone: mask(r.destination), expiresInMinutes: r.expiresInMinutes });
    }

    if (b.action === 'confirm') {
      const r = await confirmPhoneVerification(subject, String(b.code ?? ''));
      if (!r.ok) return res.status(400).json({ message: r.message });
      return res.status(200).json({ ok: true, phone: mask(r.e164), verified: true, message: 'Mobile number confirmed.' });
    }

    return res.status(400).json({ message: 'Unknown action.' });
  }

  res.setHeader('Allow', 'GET, POST');
  return res.status(405).json({ message: 'Method Not Allowed' });
}

/** GB is the only enabled country today (lib/enabled-countries); the map is here so adding one is a
 *  line, not a search. Unknown → undefined, and toE164Digits falls back to its own default. */
function dialCodeFor(cc: string | null | undefined): string | undefined {
  const map: Record<string, string> = { GB: '44', IE: '353', US: '1' };
  return cc ? map[cc.toUpperCase()] : undefined;
}
