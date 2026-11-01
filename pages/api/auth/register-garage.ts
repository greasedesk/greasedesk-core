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
import { normaliseSignupMobile, refuseSignupMobile } from '@/lib/phone-format';
import { toE164Digits } from '@/lib/contact-routes';
import { alertGarageRegistered } from '@/lib/operator-alerts';
// THE SENTENCES. One leaf holds every word this endpoint may say about a failure, and /register
// reads the same one — see its header for the 2026-11-01 incident that put it there.
import { signupRefusal, conflictMessage, signupCreatedMessage } from '@/lib/signup-refusals';

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

    /**
     * ── THE MOBILE IS REQUIRED (owner, 2026-11-01), AND REFUSED HERE RATHER THAN ON THE PAGE ────
     * The page checks it too, with this same function so the words match, but the page's check is
     * convenience: this endpoint is the write surface and a POST does not have to come from a form.
     *
     * REFUSED BEFORE ANYTHING IS CREATED, and before the password is hashed — a signup that is
     * going to be turned away should cost nothing and leave nothing behind.
     *
     * STILL UNVERIFIED, deliberately: the shape is plausible, which is not the same as the number
     * being theirs. The onboarding step still sends a code and phone_verified_at stays null — see
     * the TwoFactorSecret write below, whose comment carries the rest of that reasoning.
     */
    const mobileRefusal = refuseSignupMobile(mobile);
    if (mobileRefusal) {
      return res.status(400).json({ ok: false, where: 'validate', message: mobileRefusal });
    }
    /**
     * ONE PARSER, AND IT CANNOT DISAGREE WITH THE REFUSAL ABOVE. toE164Digits is the comms spine's
     * normaliser; refuseSignupMobile has already accepted the shape, so a null here would mean our
     * two parsers disagree about the same string — which is a refusal and not something to write
     * around. Nothing should reach it; it costs one comparison, and the alternative is a garage
     * whose mobile silently never landed.
     */
    const mobileE164 = toE164Digits(normaliseSignupMobile(mobile));
    if (!mobileE164) {
      console.error('[register-garage] a mobile passed refuseSignupMobile and produced no E.164 — refusing');
      return res.status(400).json({ ok: false, where: 'validate', message: 'We could not read that mobile number.' });
    }

    /**
     * ── BOTH COLUMNS, BECAUSE THE CHECK AND THE CONSTRAINT WERE ON DIFFERENT ONES ───────────────
     * This read `User.email` alone for a year. The FIRST statement in the transaction below writes
     * `Group.billing_email`, which carries its own `@unique` — so an address held by a garage with
     * no user account on it passed this check and then collided inside the transaction. On
     * 2026-11-01 that is exactly what happened to the owner's own signup: zero User rows for the
     * address, one Group holding it as its billing email, and a raw P2002 on the screen.
     *
     * Checked HERE rather than left to the mapped catch so the refusal costs nothing: no bcrypt
     * hash, no transaction, and no group `ref` burned out of the sequence by a rolled-back insert.
     * The mapping in the catch stays as the net for the race — two simultaneous signups on one
     * address, which no pre-check can close.
     *
     * TWO SITUATIONS, TWO SENTENCES. An account they can sign into is not the same as a garage
     * holding the address with no account on it, and "reset your password" is a dead end in the
     * second case. Both sentences come from the registry, so the pre-check and the catch cannot
     * tell one person two different things about one problem.
     */
    const [existing, existingGroup] = await Promise.all([
      prisma.user.findUnique({ where: { email: emailNorm }, select: { id: true } }),
      prisma.group.findUnique({ where: { billing_email: emailNorm }, select: { id: true } }),
    ]);
    if (existing) {
      return res
        .status(409)
        .json({ ok: false, where: 'unique', message: conflictMessage('user_email') });
    }
    if (existingGroup) {
      return res
        .status(409)
        .json({ ok: false, where: 'unique', message: conflictMessage('billing_email') });
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
    /**
     * ── THE COMMIT, AND THE ONLY PLACE A FAILURE MAY STILL BE REPORTED ──────────────────────────
     * Its own try, for a reason that is the whole of item (c): once this resolves, the garage
     * EXISTS, and nothing after it is allowed to tell the person it did not. Everything below the
     * transaction therefore runs under a catch that logs and changes nothing.
     */
    const commitSignup = () => prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      const group = await tx.group.create({
        // ref is auto-assigned by the DB sequence default; status defaults to 'trial'.
        // group_name is a NEUTRAL placeholder, never the person's name — the onboarding site step
        // asks the real garage name and it's mandatory there (item-13). "Iain Gunn's Garage" was this
        // personal-name default surviving because setup used to be skippable; it no longer is.
        data: {
          group_name: 'New garage', billing_email: emailNorm, trial_ends_at: await trialEndsAt(), signup_ref: signupRef,
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

      /**
       * THE MOBILE (owner, 2026-10-31 optional, 2026-11-01 REQUIRED) — the PERSON'S number, where
       * the onboarding "Confirm your mobile number" step looks for it.
       *
       * THE WRITE IS UNCONDITIONAL NOW, and that is the change: the refusal above means every
       * garage arriving here gave one. There is no `if` left to hide a signup that quietly stored
       * no number at all.
       *
       * ── WHY NOT Group.phone, WHICH IS WHERE IT WENT FIRST ──────────────────────────────────
       * Group.phone is the COMPANY contact number — the customer-facing fallback when a site has
       * none. A personal mobile given to "help you get set up" would have become the number this
       * garage's own customers are given. And pages/api/setup-wizard counts the contact step
       * complete on `!!(group.phone || group.whatsapp)`, so it would also have marked that step
       * done and skipped it, which means the number was never confirmed by anybody.
       *
       * ── WHY phone_recorded_at STAYS NULL, AND WHY THAT IS THE WHOLE POINT ──────────────────
       * lib/onboarding keys the phone step on `phone_recorded_at`, NOT on `phone_e164`. So a row
       * with the number and no recorded-at is exactly the state wanted: the step still stands, the
       * SMS code is still required, and the number is there to be offered rather than retyped.
       * `enabled` false and `phone_verified_at` null for the same reason — nothing here is proof
       * of anything, it is a number somebody typed into a signup form.
       *
       * toE164Digits is the comms spine's normaliser (lib/contact-routes); a second parser here
       * would be a second answer to "what is this number".
       */
      await tx.twoFactorSecret.create({
        data: {
          subject_type: 'tenant', subject_id: user.id,
          method: 'sms', secret: null,
          phone_e164: mobileE164,
          // NOT recorded, NOT verified, NOT enabled. See above.
          phone_recorded_at: null, phone_verified_at: null, enabled: false,
        },
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
    // INFERRED, NOT ANNOTATED. Hoisting the call into a named closure is what lets the result keep
    // the type Prisma gave it across the try boundary — an annotation written by hand here would be
    // the one place in this file where `group.trial_ends_at` stopped being checked.
    let committed: Awaited<ReturnType<typeof commitSignup>>;
    try {
      committed = await commitSignup();
    } catch (txErr: any) {
      // THE DATABASE'S WORDS STOP HERE. A known conflict becomes the sentence for that conflict; a
      // unique index nobody mapped becomes a 409 with the generic sentence, because the status can
      // be honest even when we cannot say which field clashed; anything else is a 500. The full
      // error — code, meta, stack — goes to the server log, which is where it is of any use.
      const refusal = signupRefusal(txErr);
      console.error(`register-garage refused at the commit [${refusal.code}]:`, txErr);
      return res.status(refusal.status).json({ ok: false, where: 'conflict', message: refusal.message });
    }
    const { user, group, attribution } = committed;

    /**
     * ── FROM HERE DOWN, NOTHING MAY REPORT A FAILURE (owner, 2026-11-01, item c) ─────────────────
     * The garage is committed. The referral, the prospect record, the owner's alert, the
     * verification token and the email are all AFTER it, and until now they sat in the same try as
     * the transaction: a throw on the token insert returned a 500 for a signup that had succeeded.
     * The person would have seen "Registration failed", tried again, and been told the address was
     * taken — by their own account, created seconds earlier.
     *
     * So the whole tail is wrapped. Each step keeps its own narrower catch where it had one (those
     * say which step failed); this one is the floor under all of them. The only thing it changes is
     * `verifySent`, and that only changes which TRUE sentence the person is given.
     */
    let verifySent = false;
    try {
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
    verifySent = !!notified.ok;
    } catch (afterErr) {
      // A COMMITTED GARAGE AND A BROKEN TAIL. Logged in full and answered 201, because the account
      // is real: the person must not be told otherwise, and the verification sentence below already
      // says what to do when the email did not go.
      console.error('register-garage: the garage was created, but a step after the commit failed:', afterErr);
    }

    return res.status(201).json({
      ok: true,
      where: 'success',
      message: signupCreatedMessage(verifySent),
      // WHETHER THE EMAIL ACTUALLY WENT, said rather than assumed. The page redirects to
      // /onboarding/check-email, whose whole text is "we've sent a verification link to …" — a
      // claim it cannot make when the send failed. It carries this through as `verify=0`.
      verifySent,
      user,
      // The signup SUCCEEDED either way; this says what became of the referral code, if there was
      // one. Null message = nothing to report. The page shows it rather than swallowing it, so a
      // mistyped code is visible to the person who can still fix it with whoever gave it to them.
      attribution: { ok: attribution.attributed, reason: attribution.reason, message: attribution.message },
    });
  } catch (err: any) {
    /**
     * ── EVERYTHING BEFORE THE COMMIT, AND NOT ONE WORD OF IT FROM THE DATABASE ──────────────────
     * What was here until 2026-11-01: the Prisma code and the instruction "Check your schema
     * constraints" rendered to a customer, and below it `err.message` for anything else — any
     * internal message, straight to the browser. Both are gone. The error is logged in full,
     * server-side, which is the only place it does any good, and the person gets one of the
     * registry's sentences.
     *
     * The commit has its own catch above, so what reaches here is a failure BEFORE any row existed
     * — a conflict found by the race, a hash that threw, a lookup that died. Nothing was created.
     */
    const refusal = signupRefusal(err);
    console.error(`register-garage FATAL ERROR [${refusal.code}]:`, err);
    return res.status(refusal.status).json({ ok: false, where: 'catch', message: refusal.message });
  }
}