/**
 * File: pages/api/account/phone.ts
 * The logged-in user's OWN mobile: send a code, confirm it, see the state. Self only — the number is
 * a security destination, and one person must never be able to point another's at their handset.
 *
 *   GET                                    → the state (the number is MASKED, see below)
 *   POST { action:'send', phone, channel } → mint + send a code (all five limits, fail-closed)
 *   POST { action:'confirm', code }        → verify and record it
 *
 * ── IT GATES SIGNUP NOW ─────────────────────────────────────────────────────────────────────────
 * It used to gate nothing; the phone step is inside ONBOARDING_ORDER as of 2026-08-09, so what this
 * endpoint writes is what lets an admin through to checkout. That makes two things load-bearing that
 * were previously merely tidy: GET must report whether a channel is actually available (a mandatory
 * step whose only channel is down has to say so BEFORE asking), and confirm must not let the caller
 * choose which channel it is being credited for.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { prisma } from '@/lib/db';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/pages/api/auth/[...nextauth]';
import { clientIp } from '@/lib/auth-rate-limit';
import { COMPANY } from '@/lib/company-info';
import { sendPhoneVerification, confirmPhoneVerification } from '@/lib/phone-verification';
import { liveCodeDestination } from '@/lib/delivered-code';
import { channelConfigured } from '@/lib/notify';

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
  const me = await prisma.user.findUnique({ where: { id: u.id as string }, select: { email: true } });
  const groupId = u.group_id as string;

  const row = await prisma.twoFactorSecret.findUnique({
    where: { subject_type_subject_id: { subject_type: 'tenant', subject_id: subject.id } },
    select: { phone_e164: true, phone_verified_at: true, phone_recorded_at: true, phone_confirmed_via: true },
  });

  if (req.method === 'GET') {
    // `pending` is the number a live code was sent to. It can differ from `phone` now that a new
    // number no longer displaces a confirmed one — the surface must be able to say "confirmed this,
    // awaiting confirmation on that" instead of showing one number and meaning two things.
    const pending = await liveCodeDestination(subject, 'phone_verify');
    return res.status(200).json({
      phone: mask(row?.phone_e164 ?? null),
      // `verified` = a HANDSET answered. `recorded` = confirmed by some channel, which is what the
      // signup gate needs. Two fields because they are two claims — see lib/phone-verification.
      verified: !!row?.phone_verified_at,
      recorded: !!row?.phone_recorded_at,
      confirmedVia: row?.phone_confirmed_via ?? null,
      codeOutstanding: !!pending,
      pendingPhone: mask(pending),
      pendingDiffers: !!pending && !!row?.phone_e164 && pending !== row.phone_e164,
      // TOLD UP FRONT, not discovered on submit. A mandatory step whose only channel is down must
      // say so before it asks for a number.
      smsAvailable: channelConfigured('sms'),
      emailAvailable: channelConfigured('email'),
      supportPhone: COMPANY.phone,
    });
  }

  if (req.method === 'POST') {
    const b = (req.body || {}) as { action?: string; phone?: string; code?: string; channel?: string };

    if (b.action === 'send') {
      const raw = String(b.phone ?? '').trim();
      if (!raw) return res.status(400).json({ code: 'bad_number', message: 'Enter your mobile number.' });
      // NOTE: the route does NOT clear codes. It used to, unconditionally, which silently defeated
      // the resend cooldown — clearing the row removed the timestamp the cooldown is measured from.
      // The rule now lives in sendPhoneVerification, which is the only place that knows whether the
      // number actually changed.
      const country = await prisma.group.findUnique({ where: { id: groupId }, select: { country_code: true } });
      // The caller may ask for email explicitly (the fallback link), or be given it automatically
      // when SMS is not configured — a mandatory step must use whatever channel it has.
      const wants = String(b.channel ?? '') === 'email' ? 'email' : (channelConfigured('sms') ? 'sms' : 'email');
      const r = await sendPhoneVerification({
        subject, groupId, rawPhone: raw, ip: clientIp(req.headers as any),
        countryDialCode: dialCodeFor(country?.country_code),
        channel: wants, emailTo: me?.email ?? null,
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
      return res.status(200).json({ ok: true, phone: mask(r.destination), expiresInMinutes: r.expiresInMinutes, channel: r.channel, sentToEmail: r.channel === 'email' ? me?.email ?? null : null });
    }

    if (b.action === 'confirm') {
      // NO CHANNEL FROM THE CLIENT. It is read off the code row inside the chokepoint — the browser
      // must not be able to tell us that the code it just typed arrived by text.
      const r = await confirmPhoneVerification(subject, String(b.code ?? ''));
      if (!r.ok) return res.status(400).json({ message: r.message });
      return res.status(200).json({
        ok: true, phone: mask(r.e164), verified: r.via === 'sms', via: r.via,
        message: r.via === 'sms'
          ? 'Mobile number confirmed.'
          : 'Number saved. You confirmed by email, so we haven’t proved the handset yet — send yourself a text from your account settings whenever you like.',
      });
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
