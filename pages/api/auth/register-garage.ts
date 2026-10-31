/**
 * File: pages/api/auth/register-garage.ts
 * Last edited: 2025-11-13 18:10 Europe/London (FINAL FIX - REMOVED LOCALHOST FALLBACK & ADDED EMAIL LOGO)
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { prisma } from '@/lib/db';
import { formatProfileDate, getProfile, DEFAULT_COUNTRY } from '@/lib/locale-profiles';
import * as bcrypt from 'bcryptjs';
import { UserRole, Prisma } from '@prisma/client';
import { sendNotification } from '@/lib/notify';
import crypto from 'crypto';
import { trialEndsAt, trialDays } from '@/lib/programme-settings';
import { ensureStartingPlanTerms } from '@/lib/billing-plans';
import { findPartyByRefCode, type RefMatch } from '@/lib/attribution';
import { attributeAtSignup } from '@/lib/affiliate';
import { normaliseHeardAbout, normaliseHeardAboutOther, normaliseUtm } from '@/lib/signup-source';
import { normaliseSignupMobile } from '@/lib/phone-format';
import { alertGarageRegistered } from '@/lib/operator-alerts';

type Payload = {
  name: string; email: string; password: string; ref?: string;
  heardAbout?: unknown; heardAboutOther?: unknown; utm?: unknown; mobile?: unknown;
};

export const config = {
  api: { bodyParser: true },
};

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  // Always declare JSON so clients don’t try to parse as something else.
  res.setHeader('Content-Type', 'application/json; charset=utf-8');

  // ── Probe mode to prove client parsing is fine (set DEBUG_REGISTER_PROBE=1)
  if (process.env.DEBUG_REGISTER_PROBE === '1') {
    return res
      .status(200)
      .json({ ok: true, where: 'probe', hint: 'Disable DEBUG_REGISTER_PROBE to run full flow.' });
  }

  if (req.method !== 'POST') {
    res.setHeader('Allow', ['POST']);
    return res
      .status(405)
      .json({ ok: false, where: 'method-guard', message: `Method ${req.method} Not Allowed` });
  }

  try {
    const { name, email, password, ref, heardAbout, heardAboutOther, utm, mobile } = (req.body || {}) as Payload;
    // Marketing attribution (dormant): sanitise + cap; never trust the client's raw value. null when absent.
    const signupRef = (typeof ref === 'string' ? ref.replace(/[^a-zA-Z0-9._-]/g, '').slice(0, 64) : '') || null;

    // HOW THEY SAY THEY FOUND US, AND WHAT THE LINK SAID. THE ONLY WRITER of these five columns,
    // and therefore the only thing enforcing the option list: heard_about carries no CHECK (the
    // set is marketing copy, and a CHECK would make a rewording a constraining migration), so
    // normaliseHeardAbout IS the constraint. Anything not on the list lands as NULL rather than
    // putting a client's own string into our figures. None of this is validated in the sense of
    // being REQUIRED — a signup must never fail over an optional marketing question.
    const heard = normaliseHeardAbout(heardAbout);
    const heardOther = normaliseHeardAboutOther(heard, heardAboutOther);
    const utmParts = normaliseUtm(utm);
    // ... (Validation logic remains unchanged) ...
    if (!name || !email || !password) {
      return res
        .status(400)
        .json({ ok: false, where: 'validate', message: 'Name, email and password are required.' });
    }
    const emailNorm = email.trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(emailNorm)) {
      return res
        .status(400)
        .json({ ok: false, where: 'validate', message: 'Please enter a valid email address.' });
    }
    if (password.length < 8) {
      return res
        .status(400)
        .json({ ok: false, where: 'validate', message: 'Password must be at least 8 characters.' });
    }

    const existing = await prisma.user.findUnique({ where: { email: emailNorm } });
    if (existing) {
      return res
        .status(409)
        .json({ ok: false, where: 'unique', message: 'An account with this email already exists.' });
    }

    const passwordHash = await bcrypt.hash(password, 12);

    // WHO SENT THEM — RESOLVED HERE, OUTSIDE THE TRANSACTION, BECAUSE IT IS A READ.
    // The write goes in with the garage (see attributeAtSignup); the lookup stays out, so a
    // database hiccup resolving a code costs the referral and not the customer. `none` is the
    // honest value for "we could not find out", and it attributes nothing.
    let refMatch: RefMatch = { status: 'none' };
    if (signupRef) {
      try {
        refMatch = await findPartyByRefCode(prisma, signupRef);
      } catch (refErr) {
        console.error('findPartyByRefCode at signup failed (non-fatal):', refErr);
      }
    }
    // ... (Prisma transaction logic remains unchanged) ...
    const { user, group, attribution } = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      const group = await tx.group.create({
        // ref is auto-assigned by the DB sequence default; status defaults to 'trial'.
        // group_name is a NEUTRAL placeholder, never the person's name — the onboarding site step
        // asks the real garage name and it's mandatory there (item-13). "Iain Gunn's Garage" was this
        // personal-name default surviving because setup used to be skippable; it no longer is.
        data: {
          group_name: 'New garage', billing_email: emailNorm, trial_ends_at: await trialEndsAt(), signup_ref: signupRef,
          // OPTIONAL MOBILE (owner, 2026-10-31), so somebody can be rung about getting set up —
          // the "registered, no checkout after an hour" alert exists for exactly that call and had
          // no number to show. Normalised here, not trusted from the browser: the client trims as a
          // convenience and this is the side that decides. Blank stays NULL.
          phone: normaliseSignupMobile(mobile),
          heard_about: heard, heard_about_other: heardOther,
          utm_source: utmParts.source, utm_medium: utmParts.medium, utm_campaign: utmParts.campaign,
        },
      });

      const user = await tx.user.create({
        data: {
          name: name.trim(),
          email: emailNorm,
          passwordHash,
          role: UserRole.ADMIN, // primary subscriber
          is_owner: true,       // immutable owner of the new group
          group_id: group.id,
          is_active: true,
          emailVerified: null,
        },
        select: { id: true, email: true, name: true },
      });

      // THE GARAGE'S FIRST TERMS ROW, in the SAME transaction as the garage. Outside it, a failure
      // between the two would leave a garage with no record of what it was offered — and the whole
      // point of the backfill was that there is one shape for every garage.
      await ensureStartingPlanTerms(tx, group.id);

      // AND WHO REFERRED THEM, in the SAME transaction, for the same reason the plan terms are.
      // A garage committed without the record of who sent it is an affiliate who introduced a
      // customer and will never be paid — found weeks later, when the money is already spent.
      const attribution = await attributeAtSignup(tx, {
        groupId: group.id,
        match: refMatch,
        garage: { email: emailNorm, company: name.trim() },
      });

      return { user, group, attribution };
    });

    // ATTRIBUTION, SECOND CHANCE. The transaction above has already attributed every signup whose
    // code resolved, so this runs only when it did not — the lookup threw, or no party held that
    // code yet. It is idempotent (attributeGroup refuses a duplicate), so the cost of it running
    // needlessly is two reads, and the cost of it NOT running is a referral that depended on one
    // query succeeding. If no party exists yet the raw signup_ref stays intact and the deferred
    // path (resolveAttributionsForRep) picks it up when one is created.
    if (signupRef && !attribution.attributed) {
      try {
        const { resolveAttribution } = await import('@/lib/attribution');
        await resolveAttribution(prisma, group.id);
      } catch (attrErr) {
        console.error('resolveAttribution at signup failed (non-fatal):', attrErr);
      }
    }

    // PROSPECT → CUSTOMER: any prospect holding this address leaves the follow-up sequence, is marked
    // signed up, and has the prospecting copy of the person removed (lib/prospect-store). Best-effort
    // and non-fatal, exactly like attribution above: a prospect-side error must never fail a signup.
    // And it is SAFE to fail, because it is not the only guard — the send path refuses any address
    // that already belongs to a customer (lib/prospect-suppression), whether or not this ran.
    try {
      const { markSignedUpByEmail } = await import('@/lib/prospect-store');
      await markSignedUpByEmail(user.email, group.id);
    } catch (prospectErr) {
      console.error('markSignedUpByEmail at signup failed (non-fatal):', prospectErr);
    }

    // TELL THE OWNER A GARAGE REGISTERED. Fired here, after the garage is committed and before the
    // response, so he hears about it in seconds rather than on the next hour's sweep — and awaited
    // deliberately: a signup already waits for the verification email, and an unawaited promise in
    // a serverless function can be killed when the response is returned.
    //
    // IT CANNOT FAIL THIS REQUEST. sendOperatorAlert catches its own errors and returns an
    // outcome; there is no throw to catch here and no branch on the result, because nothing about
    // a garage's signup depends on whether we managed to email ourselves about it.
    // CAPPED AT THREE SECONDS (owner, 2026-10-30). It could never fail this request; it could
    // still SLOW it, because a provider that accepts a connection and then thinks for thirty
    // seconds is a thirty-second signup. The send is not cancelled — it goes on, and if it
    // finishes it writes its own row, which is what the sweep reads. So a slow send is one email,
    // late, rather than two or none.
    const alerted = await alertGarageRegistered(prisma, group.id);
    if (alerted.timedOut) console.warn('[register] owner alert did not answer in 3s — the hourly sweep will finish it:', group.id);
    if (alerted.error) console.error('[register] owner alert not sent:', alerted.error);

    const token = crypto.randomBytes(32).toString('hex');
    const expires = new Date(Date.now() + 24 * 60 * 60 * 1000);

    await prisma.verificationToken.create({
      data: { identifier: user.email, token, expires },
    });

    // 🛑 FIX: Use the Vercel variable or force the production domain.
    // This removes the stubborn 'localhost' fallback.
    const baseUrl = process.env.NEXTAUTH_URL || 'https://greasedesk.com'; 
    const verificationLink = `${baseUrl}/api/auth/verify?token=${token}`;
    
    // THROUGH THE CHOKEPOINT (2026-07-31). This was the last send with its own inline Resend
    // client and its own hand-rolled HTML — the first email a tenant ever receives, recorded
    // nowhere. It now names a template and writes a NotificationLog row like everything else.
    // Non-fatal by design: a signup must never fail because an email didn't go.
    const notified = await sendNotification({
      recipient: user.email,
      template: 'signup_verify',
      channel: 'email',
      groupId: group.id,
      subject: { type: 'user', id: user.id },
      // THE DATE, because this request has one (owner, 2026-10-29). Group.trial_ends_at was
      // stamped inside the signup transaction above, so the first email a garage receives can name
      // the day its card would be charged instead of only how long it has. `when` is formatted
      // here, through the profile — the template never formats a date.
      data: {
        name: user.name || 'there',
        link: verificationLink,
        trialDays: await trialDays(),
        when: group.trial_ends_at
          ? formatProfileDate(getProfile(group.country_code ?? DEFAULT_COUNTRY), group.trial_ends_at, { long: true })
          : null,
      },
    });
    if (!notified.ok) console.warn('[register] verification email not sent:', notified.status, notified.reason, verificationLink);

    return res.status(201).json({
      ok: true,
      where: 'success',
      message: 'Account created. Please check your email to verify.',
      user,
      // The signup SUCCEEDED either way; this says what became of the referral code, if there was
      // one. Null message = nothing to report. The page shows it rather than swallowing it, so a
      // mistyped code is visible to the person who can still fix it with whoever gave it to them.
      attribution: { ok: attribution.attributed, reason: attribution.reason, message: attribution.message },
    });
  } catch (err: any) {
    // ENHANCED LOGGING: Now includes Prisma and generic errors
    console.error('register-garage FATAL ERROR:', err);
    
    let clientMessage = 'Registration failed due to a server error (check console).';

    if (err instanceof Prisma.PrismaClientKnownRequestError) {
        clientMessage = `Database error: ${err.code}. Check your schema constraints.`;
    } else if (typeof err?.message === 'string') {
        clientMessage = err.message;
    }
    
    return res.status(500).json({ ok: false, where: 'catch', message: clientMessage });
  }
}