/**
 * File: lib/delivered-code.ts
 * THE one-time code we SEND somewhere — the only reader/writer of DeliveredCode.
 *
 * Distinct from lib/two-factor, which owns the factor a subject HOLDS (a TOTP secret, recovery
 * codes). This owns codes with a destination and an expiry. Actor-agnostic on the same { type, id }
 * Subject, and purpose-scoped so one table serves every use without them leaking into each other.
 *
 * ── WHY ONE TABLE ───────────────────────────────────────────────────────────────────────────────
 * A signup phone verification and an SMS login code are the same mechanism asked twice. A second
 * table would mean a second expiry rule, a second attempt cap, and eventually a divergence where one
 * of them is wrong. `purpose` keeps them apart at the lookup: a code minted to verify a phone can
 * never satisfy a login, because a login only ever queries `login_2fa`.
 *
 * ── THREE THINGS THE ROW GUARANTEES ─────────────────────────────────────────────────────────────
 *  • HASHED — sha256 only. Somebody reading the database cannot sign in as anybody.
 *  • SINGLE-USE — consumed_at is set inside a conditional update, so a code cannot be spent twice
 *    even if two requests arrive together.
 *  • PER-CODE ATTEMPT CAP — 5 wrong guesses kill THIS code. That is the delivered-code analogue of
 *    the rotating-TOTP lockout in lib/two-factor. Both exist because they answer different
 *    questions: "has this code been attacked?" versus "has this account been attacked?".
 *
 * ── SIX DIGITS IS FINE HERE, AND WOULDN'T BE WITHOUT THE CAP ────────────────────────────────────
 * 1,000,000 codes with 5 attempts is a 1-in-200,000 chance per code, whatever the window. The same
 * six digits with unlimited guesses is not a credential at all — which is exactly the hole the TOTP
 * slice closed for operators. The cap is not a nicety; it is what makes the length acceptable.
 */
import crypto from 'crypto';
import { prisma } from '@/lib/db';

export type CodeSubjectType = 'tenant' | 'operator' | 'rep';
export type CodeSubject = { type: CodeSubjectType; id: string };
export type CodePurpose = 'phone_verify' | 'login_2fa';
/** The delivery channel a code actually travelled on. Recorded at issue; see model DeliveredCode. */
export type CodeChannel = 'sms' | 'email';

/**
 * THE code's life, and the ONLY place it is stated as a number. Everything that tells a user how
 * long they have — the SMS body, the email, the on-screen line — is handed this value; nothing
 * repeats it. A message that says "5 minutes" against a 15-minute code is a small lie that teaches
 * people to distrust the whole flow, and the way that happens is a second copy of the figure.
 *
 * 15 rather than 5 (ruling 2026-08-08): a code has to survive a person walking to where they left
 * their phone. Five minutes is comfortable for someone holding the handset and hostile to everyone
 * else, and the cost of the longer window is bounded by the things that actually protect the code —
 * single use, five attempts, and superseding on resend — not by its lifetime.
 */
export const CODE_TTL_MINUTES = 15;
export const CODE_MAX_ATTEMPTS = 5;
/** How long before a fresh code may be requested for the same subject+purpose. */
export const CODE_RESEND_COOLDOWN_SECONDS = 60;

const sha256 = (raw: string) => crypto.createHash('sha256').update(raw).digest('hex');
/** Digits only — a code typed with a stray space must not fail for that reason. */
const normalise = (raw: string) => String(raw ?? '').replace(/\D/g, '');

/**
 * SIX DIGITS, UNIFORM. randomInt is rejection-sampled by Node, so there is no modulo bias — with
 * `randomBytes % 1000000` the low codes would be very slightly likelier, which is a small flaw in a
 * thing whose entire job is being unguessable.
 */
export function newCode(): string {
  return String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
}

export type IssueRefusal = { code: 'cooldown'; retryAfterSeconds: number };

/**
 * Seconds left on the cooldown, or 0. Exposed so a caller can check it BEFORE spending anything
 * else — issueCode enforces it too (it is the code's own rule and must not depend on a caller
 * remembering), but a caller that draws on a money budget needs to ask first.
 */
export async function cooldownRemaining(subject: CodeSubject, purpose: CodePurpose): Promise<number> {
  const recent = await prisma.deliveredCode.findFirst({
    where: { subject_type: subject.type, subject_id: subject.id, purpose },
    orderBy: { created_at: 'desc' },
    select: { created_at: true },
  });
  if (!recent) return 0;
  const elapsed = (Date.now() - recent.created_at.getTime()) / 1000;
  return elapsed >= CODE_RESEND_COOLDOWN_SECONDS ? 0 : Math.max(1, Math.ceil(CODE_RESEND_COOLDOWN_SECONDS - elapsed));
}

/**
 * Mint a code for this subject+purpose. Supersedes any live one — a user who asks again is telling
 * us the first did not arrive, and leaving both valid would widen the guessing surface for no gain.
 *
 * COOLDOWN IS ENFORCED HERE, not at the caller, because it protects money: every issue is an SMS.
 * Returns a refusal rather than throwing so the caller can say "try again in 40 seconds" honestly.
 */
export async function issueCode(
  subject: CodeSubject,
  purpose: CodePurpose,
  destination: string,
  /** How it is about to be delivered. Stored so verify can trust it later — see the model comment. */
  channel: CodeChannel = 'sms',
): Promise<{ code: string; expiresAt: Date } | IssueRefusal> {
  const recent = await prisma.deliveredCode.findFirst({
    where: { subject_type: subject.type, subject_id: subject.id, purpose },
    orderBy: { created_at: 'desc' },
    select: { created_at: true },
  });
  if (recent) {
    const elapsed = (Date.now() - recent.created_at.getTime()) / 1000;
    if (elapsed < CODE_RESEND_COOLDOWN_SECONDS) {
      return { code: 'cooldown', retryAfterSeconds: Math.max(1, Math.ceil(CODE_RESEND_COOLDOWN_SECONDS - elapsed)) };
    }
  }

  const code = newCode();
  const expiresAt = new Date(Date.now() + CODE_TTL_MINUTES * 60 * 1000);
  await prisma.$transaction([
    // The old ones go, rather than lingering unusable — this table would otherwise grow one row per
    // resend forever, and nothing else prunes it.
    prisma.deliveredCode.deleteMany({ where: { subject_type: subject.type, subject_id: subject.id, purpose } }),
    prisma.deliveredCode.create({
      data: {
        subject_type: subject.type, subject_id: subject.id, purpose,
        destination, channel, code_hash: sha256(code), expires_at: expiresAt,
      },
    }),
  ]);
  return { code, expiresAt };
}

export type VerifyResult =
  | { ok: true; destination: string; channel: CodeChannel }
  | { ok: false; reason: 'no_code' | 'expired' | 'wrong' | 'exhausted'; attemptsLeft: number };

/**
 * Check a typed code. Every failure path is distinguishable to the CALLER (so it can say something
 * true) but the messages a user sees deliberately collapse 'wrong' and 'exhausted' into one line —
 * telling an attacker which of their guesses burned the code is free information.
 *
 * The attempt increment happens BEFORE the comparison, so a crash mid-verify cannot hand back a
 * free guess.
 */
export async function verifyCode(subject: CodeSubject, purpose: CodePurpose, typed: string): Promise<VerifyResult> {
  const row = await prisma.deliveredCode.findFirst({
    where: { subject_type: subject.type, subject_id: subject.id, purpose, consumed_at: null },
    orderBy: { created_at: 'desc' },
  });
  if (!row) return { ok: false, reason: 'no_code', attemptsLeft: 0 };
  if (row.expires_at.getTime() <= Date.now()) return { ok: false, reason: 'expired', attemptsLeft: 0 };
  if (row.attempts >= CODE_MAX_ATTEMPTS) return { ok: false, reason: 'exhausted', attemptsLeft: 0 };

  const attempts = row.attempts + 1;
  await prisma.deliveredCode.update({ where: { id: row.id }, data: { attempts } });

  if (sha256(normalise(typed)) !== row.code_hash) {
    const left = Math.max(0, CODE_MAX_ATTEMPTS - attempts);
    return { ok: false, reason: left === 0 ? 'exhausted' : 'wrong', attemptsLeft: left };
  }

  // CONDITIONAL consume — `consumed_at: null` in the where clause means two simultaneous correct
  // submissions cannot both win.
  const consumed = await prisma.deliveredCode.updateMany({
    where: { id: row.id, consumed_at: null }, data: { consumed_at: new Date() },
  });
  if (consumed.count !== 1) return { ok: false, reason: 'no_code', attemptsLeft: 0 };
  // The channel comes off the ROW, which is the only account of how the code actually travelled.
  // A caller-supplied channel would let a user who received an emailed code assert 'sms' and mint a
  // phone_verified_at with no handset in the story — the exact claim SMS 2FA is later built on.
  return { ok: true, destination: row.destination, channel: (row.channel === 'email' ? 'email' : 'sms') };
}

/**
 * The destination a live code was sent to, or null. Since a pending number NO LONGER displaces a
 * verified one (see lib/phone-verification.storeUnverified), the code row is the only place the
 * number being confirmed exists — so this is how a surface shows "confirmed •••999, code sent to
 * •••332" rather than silently conflating the two.
 */
export async function liveCodeDestination(subject: CodeSubject, purpose: CodePurpose): Promise<string | null> {
  const row = await prisma.deliveredCode.findFirst({
    where: {
      subject_type: subject.type, subject_id: subject.id, purpose,
      consumed_at: null, expires_at: { gt: new Date() }, attempts: { lt: CODE_MAX_ATTEMPTS },
    },
    select: { destination: true },
  });
  return row?.destination ?? null;
}

/** Is a live, unexpired, unexhausted code outstanding? Drives "we've sent you a code" UI state. */
export async function hasLiveCode(subject: CodeSubject, purpose: CodePurpose): Promise<boolean> {
  const row = await prisma.deliveredCode.findFirst({
    where: {
      subject_type: subject.type, subject_id: subject.id, purpose,
      consumed_at: null, expires_at: { gt: new Date() }, attempts: { lt: CODE_MAX_ATTEMPTS },
    },
    select: { id: true },
  });
  return !!row;
}

/** Drop every code for a subject+purpose — used when the destination changes, so a code sent to the
 *  OLD number can never verify the new one. */
export async function clearCodes(subject: CodeSubject, purpose: CodePurpose): Promise<void> {
  await prisma.deliveredCode.deleteMany({
    where: { subject_type: subject.type, subject_id: subject.id, purpose },
  }).catch(() => {});
}
