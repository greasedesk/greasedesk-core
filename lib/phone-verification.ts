/**
 * File: lib/phone-verification.ts
 * THE one place a verification code is SENT. Ties together the three chokepoints that each own one
 * part of it — lib/delivered-code (the code), lib/auth-rate-limit (the budget), lib/notify (the
 * send) — so no caller has to remember the order, and none of them can be skipped.
 *
 * ── THE BUDGET IS CHECKED BEFORE THE CODE IS MINTED ─────────────────────────────────────────────
 * Minting first would burn the previous code (issueCode supersedes) and then refuse to send — the
 * user would be left holding a code that no longer verifies and no new one on the way. Order here
 * is load-bearing: cooldown → limits → mint → send.
 *
 * ── FAIL CLOSED ON THE WAY OUT, OPEN ON THE WAY BACK ────────────────────────────────────────────
 * Every send axis uses takeTokenStrict, which REFUSES when it cannot establish that we are under the
 * limit: a database blip must not become unmetered spend. Verification (lib/delivered-code) keeps
 * the ordinary fail-open behaviour, because a user who cannot check a code is stranded and checking
 * costs nothing. Same feature, opposite stances, on purpose.
 *
 * ── WHY THE PHONE NUMBER IS NORMALISED HERE AND NOWHERE ELSE ────────────────────────────────────
 * toE164Digits is the customer spine's normaliser and returns NULL on anything it cannot parse. That
 * null is the validation: we never send to a number we could not turn into a dialable form, and we
 * never store one either, so `phone_e164` cannot hold junk.
 */
import { prisma } from '@/lib/db';
import { toE164Digits } from '@/lib/contact-routes';
import { issueCode, verifyCode, clearCodes, cooldownRemaining, CODE_TTL_MINUTES, type CodeSubject } from '@/lib/delivered-code';
import { sendNotification } from '@/lib/notify';
import {
  takeTokenStrict, SMS_LIMITS, smsSubjectKey, smsDestinationKey, smsIpKey, smsTenantKey,
} from '@/lib/auth-rate-limit';

export type SendRefusal =
  | { code: 'bad_number'; message: string }
  | { code: 'cooldown'; message: string; retryAfterSeconds: number }
  | { code: 'rate_limited'; message: string }
  | { code: 'not_sent'; message: string }
  /** The adapter has no provider/key/sender — the feature is OFF, not broken. Visibly distinct from
   *  not_sent so nobody is told to retry against something that was never switched on. */
  | { code: 'sms_unavailable'; message: string }
  /** A DEMO tenant never sends. Its own code because the sms_unavailable sentence is FALSE here:
   *  texting is switched on, the tenant is a demo. Telling a demo user the product's messaging is
   *  broken is a lie about the product, told at the moment they are evaluating it. */
  | { code: 'demo_tenant'; message: string };

export type SendOk = { ok: true; destination: string; expiresInMinutes: number; channel: 'sms' | 'email' };

/**
 * Mint and send a phone-verification code. `groupId` and `ip` are the two blast-radius axes and are
 * required rather than optional — an optional limit is one somebody forgets to pass.
 */
export async function sendPhoneVerification(args: {
  subject: CodeSubject;
  groupId: string;
  rawPhone: string;
  ip: string;
  countryDialCode?: string;
  /**
   * WHERE the code goes. 'sms' proves a handset; 'email' proves only that somebody reachable at the
   * account address holds this number. The gate accepts either; phone_verified_at accepts only the
   * first. Email needs an address — the caller supplies the account's, because this module has no
   * business deciding which address is "theirs".
   */
  channel?: 'sms' | 'email';
  emailTo?: string | null;
}): Promise<SendOk | SendRefusal> {
  const channel = args.channel ?? 'sms';
  const e164 = toE164Digits(args.rawPhone, args.countryDialCode);
  if (!e164) {
    return { code: 'bad_number', message: 'That doesn’t look like a mobile number. Check it and try again.' };
  }

  // ── A GENUINELY NEW NUMBER RESETS EVERYTHING, AND MUST DO SO FIRST ───────────────────────────
  // Order matters and this is the fix for a real defect the live gate caught: the ENDPOINT used to
  // clear codes unconditionally on every send, which deleted the row cooldownRemaining reads from —
  // so the cooldown could never fire at all, and a user hammering "resend" burned their whole hourly
  // allowance in seconds, every press a real text. Two went out during the gate before it was seen.
  //
  // The rule belongs here, not at the caller, because THIS is the only place that knows both the old
  // number and the new one. Clearing is conditional on the number actually changing: a mistyped
  // number deserves a fresh code immediately, while asking again for the SAME number is exactly what
  // the cooldown exists to slow down. Alternating between two numbers still bypasses the cooldown,
  // and is bounded by the per-subject limit rather than by this.
  const previous = await prisma.twoFactorSecret.findUnique({
    where: { subject_type_subject_id: { subject_type: args.subject.type, subject_id: args.subject.id } },
    select: { phone_e164: true },
  });
  const numberChanged = !!previous && previous.phone_e164 !== e164;
  if (numberChanged) {
    // A code sent to the OLD handset must never verify the new number.
    await clearCodes(args.subject, 'phone_verify');
  }

  // ── COOLDOWN BEFORE THE BUDGET, NOT AFTER ────────────────────────────────────────────────────
  // The limits used to be consumed first, so a resend refused by the cooldown still burned a token
  // on all four axes — an impatient user tapping "send again" could spend their whole hourly
  // allowance without a single text being sent, and then be told they were rate-limited. The limits
  // exist to protect MONEY; a request that spends none must not draw on them.
  const cooling = await cooldownRemaining(args.subject, 'phone_verify');
  if (cooling > 0) {
    return { code: 'cooldown', retryAfterSeconds: cooling, message: `Please wait ${cooling} seconds before asking for another code.` };
  }

  // ALL FOUR AXES, every time. Checked before minting so a refusal leaves the previous code intact.
  const gates = await Promise.all([
    takeTokenStrict(smsSubjectKey(args.subject.type, args.subject.id), SMS_LIMITS.perSubject.max, SMS_LIMITS.perSubject.windowMinutes),
    takeTokenStrict(smsDestinationKey(e164), SMS_LIMITS.perDestination.max, SMS_LIMITS.perDestination.windowMinutes),
    takeTokenStrict(smsIpKey(args.ip), SMS_LIMITS.perIp.max, SMS_LIMITS.perIp.windowMinutes),
    takeTokenStrict(smsTenantKey(args.groupId), SMS_LIMITS.perTenant.max, SMS_LIMITS.perTenant.windowMinutes),
  ]);
  if (gates.some((g) => !g)) {
    // ONE MESSAGE for every axis. Telling somebody which limit they hit tells an attacker which
    // dimension to vary, and the honest remedy is identical in all four cases.
    return { code: 'rate_limited', message: 'Too many codes requested. Please wait a while and try again, or continue and confirm your number later.' };
  }

  // STORE IT UNVERIFIED, BEFORE THE SEND. Two reasons, both load-bearing:
  //   • the "not confirmed" state in settings needs a number to show, or it can only ever say
  //     "no number" — there would be no way to represent "we have it, they haven't confirmed it";
  //   • if the send then fails (or SMS is not switched on) the number is genuinely saved, which is
  //     what the message tells the user. Telling somebody their number is saved and then not saving
  //     it is the kind of small lie that costs a support call.
  // phone_verified_at stays NULL — an unverified number is a note, never a credential.
  await storeUnverified(args.subject, e164);

  const issued = await issueCode(args.subject, 'phone_verify', e164, channel);
  if ('code' in issued && issued.code === 'cooldown') {
    return {
      code: 'cooldown',
      retryAfterSeconds: (issued as any).retryAfterSeconds,
      message: `Please wait ${(issued as any).retryAfterSeconds} seconds before asking for another code.`,
    };
  }

  if (channel === 'email' && !args.emailTo) {
    return { code: 'not_sent', message: 'We don’t have an email address for your account to send the code to.' };
  }
  const sent = await sendNotification({
    recipient: channel === 'email' ? (args.emailTo as string) : e164,
    template: 'phone_verify',
    channel,
    groupId: args.groupId,
    // 'user' never resolves a thread key (lib/message-threads), so a code can never land on a
    // customer conversation. Verified, not assumed — see threadKeyForSubject.
    subject: { type: 'user', id: args.subject.id },
    data: { code: (issued as { code: string }).code, expiryMinutes: CODE_TTL_MINUTES },
  });


  if (!sent.ok) {
    // The code is now live but undeliverable. Drop it: leaving it would let the user sit on an
    // "enter the code" screen for a code that never left the building.
    await clearCodes(args.subject, 'phone_verify');
    // ── UNCONFIGURED IS NOT FAILED (ruling 2026-08-08) ──────────────────────────────────────────
    // sendNotification returns `skipped` when the SMS adapter has no provider/key/sender, and
    // `failed` when a configured provider rejected the message. Collapsing them would tell a garage
    // "we couldn't send it, try again" while the truth is that texting is not switched on at all —
    // they would retry forever against a feature that does not exist yet. Different status, different
    // sentence, and the caller can tell them apart by `code`.
    // A DEMO SKIP IS NOT AN OUTAGE. Read from the CODE, not the sentence — the reason string is
    // for a log and would be a fragile thing to branch on.
    if (sent.skipCode === 'demo_tenant') {
      return {
        code: 'demo_tenant',
        message: channel === 'email'
          ? 'This is a demo, so we don’t send real emails — nothing has left the building. Your number is saved against the account.'
          : 'This is a demo, so we don’t send real texts — nothing has left the building. Your number is saved against the account.',
      };
    }
    if (sent.status === 'skipped') {
      // THE SENTENCE HAS TO NAME THE RIGHT CHANNEL. The caller now falls back to email on its own,
      // so a skip here can mean either adapter is off — and telling somebody "texting isn't switched
      // on" when the thing that failed was the email they explicitly asked for sends them back to
      // retry the channel that was never the problem.
      return {
        code: 'sms_unavailable',
        message: channel === 'email'
          ? 'We can’t email a code right now. Your number is saved as unconfirmed — please call us and we’ll finish this with you.'
          : 'Text messaging isn’t switched on for GreaseDesk yet, so we can’t send a code right now. Your number is saved as unconfirmed — you can confirm it from your account settings once it’s available.',
      };
    }
    return {
      code: 'not_sent',
      message: 'We couldn’t send the code just now. You can try again, or continue and confirm your number later.',
    };
  }
  return { ok: true, destination: e164, expiresInMinutes: CODE_TTL_MINUTES, channel };
}

export type ConfirmResult =
  /** `via` is the channel the code ACTUALLY travelled on, read off the row — so a caller can say
   *  what happened without being able to influence it. */
  | { ok: true; e164: string; via: 'sms' | 'email' }
  | { ok: false; message: string };

/**
 * Check the code and, on success, WRITE THE VERIFIED NUMBER — the two are one act, because a
 * verification that doesn't record itself is theatre.
 *
 * The row is upserted with method 'sms' left ALONE where a TOTP enrolment already exists: verifying
 * a phone must never quietly change which second factor an account uses. Only `enabled` (which this
 * never touches) decides that.
 */
export async function confirmPhoneVerification(
  subject: CodeSubject,
  typed: string,
): Promise<ConfirmResult> {
  const r = await verifyCode(subject, 'phone_verify', typed);
  if (!r.ok) {
    // 'wrong' and 'exhausted' collapse into one sentence deliberately — telling an attacker which
    // guess burned the code is free information. The remedy is the same either way.
    const message = r.reason === 'expired' || r.reason === 'no_code'
      ? 'That code has expired. Ask for a new one.'
      : r.reason === 'exhausted'
        ? 'That code is no longer valid. Ask for a new one.'
        : `That code didn’t match. ${r.attemptsLeft} attempt${r.attemptsLeft === 1 ? '' : 's'} left.`;
    return { ok: false, message };
  }

  const existing = await prisma.twoFactorSecret.findUnique({
    where: { subject_type_subject_id: { subject_type: subject.type, subject_id: subject.id } },
    select: { id: true },
  });
  // ── WHAT EACH CHANNEL IS ENTITLED TO CLAIM ───────────────────────────────────────────────────
  // phone_verified_at means a handset answered. An emailed code proves the account's inbox, not the
  // phone — so it records the number and stops there. The gate reads phone_recorded_at and passes
  // on either; SMS 2FA reads phone_verified_at and is never satisfied by an email confirmation.
  // Writing verified_at from the email path would be the one lie that quietly weakens a factor.
  // THE CHANNEL COMES FROM THE CODE ROW, not from the caller. It was briefly a parameter, which
  // meant the browser decided whether its own confirmation counted as a handset — a user who asked
  // for the email fallback could post channel:'sms' and mint a phone_verified_at against a phone
  // nobody had proved. Same fact, unforgeable source.
  const via = r.channel;
  const now = new Date();
  const stamp = via === 'sms'
    ? { phone_e164: r.destination, phone_recorded_at: now, phone_verified_at: now, phone_confirmed_via: 'sms' }
    : { phone_e164: r.destination, phone_recorded_at: now, phone_confirmed_via: 'email' };
  if (existing) {
    await prisma.twoFactorSecret.update({ where: { id: existing.id }, data: stamp });
  } else {
    // A row with no secret and enabled:false — a verified phone, and NOT a second factor. SMS 2FA
    // would later set method/enabled through the two-factor lifecycle, never here.
    await prisma.twoFactorSecret.create({
      data: {
        subject_type: subject.type, subject_id: subject.id,
        method: 'totp', secret: null, enabled: false,
        ...stamp,
      },
    });
  }
  return { ok: true, e164: r.destination, via };
}

/**
 * Record a number WITHOUT verifying it. Never touches `enabled`.
 *
 * ── AN UNPROVEN NUMBER NEVER DISPLACES A PROVEN ONE (ruling 2026-08-09) ─────────────────────────
 * This used to null phone_verified_at the moment a DIFFERENT number was entered, on the reasoning
 * that the old handset is not evidence for the new one. True — but it made the account unverified
 * before anything replaced it, so a user who mistyped a digit and walked away was left worse off
 * than before they touched it. Under a blocking gate that is a lockout caused by a typo.
 *
 * The old verification stands until the new number is CONFIRMED. It has to stand for something:
 * what it asserts is that we can reach a handset this person controls, and that stays true until a
 * different one is proven. The pending number needs no column — it is already on the
 * DeliveredCode row as `destination`, and confirmPhoneVerification promotes it from there.
 *
 * So: no verified number yet → store it unverified, which is what makes the "not confirmed" state
 * in settings representable. Already verified → leave the row completely alone.
 */
async function storeUnverified(subject: CodeSubject, e164: string): Promise<void> {
  const existing = await prisma.twoFactorSecret.findUnique({
    where: { subject_type_subject_id: { subject_type: subject.type, subject_id: subject.id } },
    select: { id: true, phone_e164: true, phone_verified_at: true },
  });
  if (existing) {
    // ALREADY VERIFIED → untouched. The pending number lives on the code row until it is proven.
    if (existing.phone_verified_at) return;
    // Not verified: overwrite freely. There is nothing to protect and the settings panel needs a
    // number to show beside "not confirmed".
    if (existing.phone_e164 !== e164) {
      await prisma.twoFactorSecret.update({ where: { id: existing.id }, data: { phone_e164: e164 } });
    }
    return;
  }
  await prisma.twoFactorSecret.create({
    data: {
      subject_type: subject.type, subject_id: subject.id,
      method: 'totp', secret: null, enabled: false,
      phone_e164: e164, phone_verified_at: null,
    },
  });
}

/**
 * ── THE CLEARING PATH (ruling 2026-08-09) ───────────────────────────────────────────────────────
 * Removes a verified number and nothing else. It CLEARS; it never sets and never re-points — an
 * admin who could aim a colleague's verification at a handset they control would hold that account,
 * which is the whole reason the number lives on the enrolment row rather than the editable profile.
 *
 * Deliberately NOT lib/two-factor.disable, which deletes the entire row: someone with a TOTP
 * enrolment must keep it when their phone is cleared. Two different erasures, two functions.
 *
 * Returns false when there was nothing to clear, so a caller can say "already clear" rather than
 * reporting a change that did not happen.
 */
export async function clearVerifiedPhone(subject: CodeSubject): Promise<boolean> {
  const row = await prisma.twoFactorSecret.findUnique({
    where: { subject_type_subject_id: { subject_type: subject.type, subject_id: subject.id } },
    select: { id: true, phone_e164: true, phone_verified_at: true, phone_recorded_at: true },
  });
  if (!row || (!row.phone_e164 && !row.phone_verified_at && !row.phone_recorded_at)) return false;
  await prisma.twoFactorSecret.update({
    where: { id: row.id },
    data: { phone_e164: null, phone_verified_at: null, phone_recorded_at: null, phone_confirmed_via: null },
  });
  // Any outstanding code was minted for the number just removed; leaving it live would let it
  // verify against a row that no longer names that destination.
  await clearCodes(subject, 'phone_verify');
  return true;
}

/** The verified number for a subject, or null. One reader, so no surface invents its own lookup. */
export async function verifiedPhone(subject: CodeSubject): Promise<string | null> {
  const row = await prisma.twoFactorSecret.findUnique({
    where: { subject_type_subject_id: { subject_type: subject.type, subject_id: subject.id } },
    select: { phone_e164: true, phone_verified_at: true },
  });
  return row?.phone_verified_at && row.phone_e164 ? row.phone_e164 : null;
}
