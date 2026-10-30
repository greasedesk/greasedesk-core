/**
 * File: pages/api/affiliate-site/signup.ts
 * STEP ONE OF BECOMING AN AFFILIATE. POST { name, email, phone, social?, findMethod?, website? }.
 *
 * It creates the affiliate and texts a code to the mobile. It does NOT hand back the referral code:
 * that is step two (confirm), after the code comes back, because a code handed out before the
 * handset is proved is a code handed to whoever typed the number.
 *
 * ── THE SWITCH IS READ HERE, NOT TRUSTED FROM THE PAGE ─────────────────────────────────────────
 * affiliate_joining_open is checked server-side on every call. The page already hides the button
 * when joining is shut, and that is a courtesy, not a guard: the form is a POST anybody can make.
 *
 * ── ONE AFFILIATE PER PERSON (owner, 2026-10-29) ───────────────────────────────────────────────
 * Rep.email is unique across reps AND affiliates, and the three cases behind that constraint are
 * decided by lib/affiliate-join::decideExisting — carry on, already done, or refuse a reseller's
 * address. Nothing here guesses which: a wrong guess either creates a second account for one person
 * or tells somebody they already have one when they do not.
 *
 * ── THE MOBILE DOES NOT GO IN Rep.phone ────────────────────────────────────────────────────────
 * That column is the PUBLISHED contact number a garage is shown, which is a different fact about a
 * different audience. The verified mobile lives where every other verified number in this codebase
 * lives — TwoFactorSecret, keyed by subject — written by confirmPhoneVerification and by nothing
 * else. A name that reads right is not the same as a name that means the right thing.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { prisma } from '@/lib/db';
import { PLATFORM_SEND } from '@/lib/notify';
import { currentTerms } from '@/lib/affiliate';
import { validateJoin, decideExisting, mintRefCode } from '@/lib/affiliate-join';
import { sendPhoneVerification } from '@/lib/phone-verification';
import { verifiedPhone } from '@/lib/phone-verification';
import { takeTokenStrict, JOIN_LIMITS_BY_IP, joinIpKey, clientIp } from '@/lib/auth-rate-limit';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).json({ ok: false, message: 'Method Not Allowed' }); }

  const body = (req.body || {}) as Record<string, unknown>;

  // HONEYPOT FIRST, accept-and-drop, and before the limiter so a bot filling the trap cannot spend
  // a real visitor's budget.
  if (typeof body.website === 'string' && body.website.trim() !== '') {
    return res.status(200).json({ ok: true, stage: 'code_sent', email: String(body.email ?? '') });
  }

  const ip = clientIp(req.headers as Record<string, string | string[] | undefined>);
  if (!(await takeTokenStrict(joinIpKey(ip), JOIN_LIMITS_BY_IP.perIp.max, JOIN_LIMITS_BY_IP.perIp.windowMinutes))) {
    return res.status(429).json({ ok: false, message: 'Too many attempts from this connection. Please try again later.' });
  }

  const terms = await currentTerms(prisma);
  if (!terms.joiningOpen) {
    // THE SAME FACT THE PAGE SHOWS, said again from the server. 409 rather than 403: nothing is
    // wrong with the request, the programme is shut.
    return res.status(409).json({ ok: false, closed: true, message: 'The programme isn’t open to new affiliates just now. Leave your email on the front page and we’ll tell you when it opens.' });
  }

  const v = validateJoin(body);
  if (!v.ok) return res.status(400).json({ ok: false, field: v.field, message: v.message });
  const f = v.fields;

  const existing = await prisma.rep.findUnique({
    where: { email: f.email },
    select: { id: true, party_type: true, ref_code: true, suspended_at: true },
  });
  const already = existing ? !!(await verifiedPhone({ type: 'rep', id: existing.id })) : false;
  const decision = decideExisting(existing as any, already);

  if (decision.action === 'refuse') return res.status(409).json({ ok: false, message: decision.message });
  if (decision.action === 'done') {
    // NOTHING TO DO, AND NOTHING LOST. They are told what they already have rather than being sent
    // round the signup again — and the code is NOT repeated here, because this endpoint has not
    // proved who is asking. The welcome email is where it lives.
    return res.status(200).json({ ok: true, stage: 'already', email: f.email, message: 'You already have an affiliate code — check the email we sent you, or give us a ring and we’ll resend it.' });
  }

  let repId: string;
  if (decision.action === 'carry_on') {
    repId = decision.repId;
    // THE DETAILS THEY TYPED THIS TIME WIN. A person coming back may be correcting the name or the
    // handle that stopped them finishing; the ref_code and the acceptance date are left alone,
    // because the code is theirs and the terms were accepted when they first pressed the button.
    await prisma.rep.update({ where: { id: repId }, data: { name: f.name, social_handle: f.social, find_method: f.findMethod } });
  } else {
    const refCode = await mintRefCode(prisma);
    const created = await prisma.rep.create({
      data: {
        party_type: 'affiliate',
        email: f.email,
        name: f.name,
        ref_code: refCode,
        social_handle: f.social,
        find_method: f.findMethod,
        // THE BUTTON ACCEPTS THE TERMS, which the form states above it, so the acceptance is dated
        // here. It is what lets a reward accrue at all (lib/affiliate::refuseUnactivated).
        terms_accepted_at: new Date(),
      },
      select: { id: true },
    });
    repId = created.id;
  }

  // ── THE TEXT. PLATFORM_SEND: a message from GreaseDesk to somebody who is not a customer, so it
  // spends the platform's own daily SMS axis rather than a garage's allowance.
  const sent = await sendPhoneVerification({
    subject: { type: 'rep', id: repId },
    groupId: PLATFORM_SEND,
    rawPhone: f.phone,
    ip,
  });

  // NARROWED ONCE, by the discriminant the union actually has. `'ok' in sent` reads as a narrowing
  // and is not one for TypeScript on the way out: every branch below would still see SendOk.
  if ('ok' in sent) {
    return res.status(200).json({ ok: true, stage: 'code_sent', email: f.email, expiresInMinutes: sent.expiresInMinutes });
  }

  // THE TEST DATABASE HANDS THE CODE BACK. Nothing was sent — Environment.kind says this is not
  // production — and the code is returned so a gate can finish the flow it is driving. Unreachable
  // in production, where the marker says production and the text goes out.
  if (sent.code === 'test_environment') {
    return res.status(200).json({ ok: true, stage: 'code_sent', email: f.email, testCode: sent.testCode, message: sent.message });
  }

  // A REFUSAL THAT IS ABOUT THE NUMBER goes back as a field error, so the form can point at it.
  if (sent.code === 'bad_number') return res.status(400).json({ ok: false, field: 'phone', message: sent.message });

  // ── THE ACCOUNT EXISTS AND THE TEXT DID NOT GO ─────────────────────────────────────────────────
  // Said plainly rather than rolled back. The row is not damage: they can ask again in a moment and
  // carry on from where they are (decideExisting returns `carry_on`), whereas deleting it would
  // throw away an accepted set of terms and a minted code for a transient SMS fault.
  return res.status(502).json({ ok: false, stage: 'no_code', email: f.email, message: sent.message });
}
