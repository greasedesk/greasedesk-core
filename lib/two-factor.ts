/**
 * File: lib/two-factor.ts
 * THE 2FA chokepoint — the only reader/writer of TwoFactorSecret / TwoFactorRecoveryCode. Actor-agnostic
 * by design: everything is keyed by a { type, id } Subject, so this exact code serves operators today
 * and tenant Users / Reps later with no rebuild — the caller just passes a different subject_type. The
 * TOTP maths is lib/totp; this owns the DB lifecycle and the lockout-safety rules.
 *
 * LIFECYCLE (2FA is not a boolean — it is this sequence):
 *   beginEnrolment → (app scans secret) → confirmEnrolment(code) enables + mints recovery codes →
 *   verifySecondFactor at login → disable / reset.
 *
 * THE LOAD-BEARING RULE: enabled flips true ONLY inside confirmEnrolment, and ONLY after a live code
 * verifies. We never enable 2FA on a secret the operator hasn't proven they can generate codes for —
 * that is how you lock someone out of their own account.
 */
import crypto from 'crypto';
import type { PrismaClient, Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';

/** A transaction client or the base client — see disable(). */
type Db = PrismaClient | Prisma.TransactionClient;
import { generateSecret, verifyTotp, otpauthURI, base32Encode } from '@/lib/totp';

export type SubjectType = 'operator' | 'tenant' | 'rep';
export type Subject = { type: SubjectType; id: string };
const where = (s: Subject) => ({ subject_type: s.type, subject_id: s.id });
const uniqueWhere = (s: Subject) => ({ subject_type_subject_id: { subject_type: s.type, subject_id: s.id } });

/**
 * ── THE ISSUER IS PERMANENT, SO IT MUST NOT BE VARIABLE ─────────────────────────────────────────
 * This string is baked into the authenticator app when the QR is scanned and stays there for the
 * life of the enrolment — renaming it later changes NOTHING on the handset. So it must be something
 * that cannot go stale.
 *
 * Operators keep 'GreaseDesk Engine Room' — an operator holds exactly one platform-staff identity.
 *
 * Tenants get plain 'GreaseDesk', deliberately NOT "GreaseDesk — Dave's Motors". A garage can rename
 * itself (trading_name and group_name are both editable), and a renamed garage would leave the OLD
 * name sitting in the owner's authenticator forever with no way to correct it. The account field
 * already carries the email, which disambiguates two accounts far better than a name that can drift.
 */
const ISSUERS: Record<SubjectType, string> = {
  operator: 'GreaseDesk Engine Room',
  tenant: 'GreaseDesk',
  rep: 'GreaseDesk Reps',
};
export const issuerFor = (t: SubjectType): string => ISSUERS[t];
/** @deprecated Read `issuerFor(subject.type)`. Kept so existing operator callers keep compiling. */
export const TOTP_ISSUER = ISSUERS.operator;
const RECOVERY_COUNT = 10;

/**
 * ── ATTEMPT LIMIT (ruling 2026-08-08) ───────────────────────────────────────────────────────────
 * There was none. Six digits is 1,000,000 codes and verifyTotp accepts a ±1-step window, so an
 * unlimited online guesser gets in. This affected OPERATORS in production, not just the new tenant
 * path, which is why it is fixed in the chokepoint rather than at one caller.
 *
 * FAILURES are counted, not attempts — a legitimate user who types five correct codes is not
 * throttled. A success clears the counter, so the only way to reach the limit is to keep being wrong.
 * Recovery codes count too: they are the higher-value target (they don't rotate every 30 seconds).
 */
export const TWO_FACTOR_MAX_FAILURES = 5;
export const TWO_FACTOR_LOCKOUT_MINUTES = 15;
const failKey = (s: Subject) => `2fa:${s.type}:${s.id}`;

const sha256 = (raw: string) => crypto.createHash('sha256').update(raw).digest('hex');
/** Normalise a typed recovery code: strip separators/space, uppercase — so 'abcde-fghij' == 'ABCDEFGHIJ'. */
const normaliseRecovery = (raw: string) => String(raw || '').toUpperCase().replace(/[^A-Z2-7]/g, '');
/** A human-typable one-time code: 10 base32 chars grouped as XXXXX-XXXXX. */
function makeRecoveryCode(): string {
  const c = base32Encode(crypto.randomBytes(8)).slice(0, 10);
  return `${c.slice(0, 5)}-${c.slice(5, 10)}`;
}

export async function isEnabled(subject: Subject): Promise<boolean> {
  const row = await prisma.twoFactorSecret.findUnique({ where: uniqueWhere(subject), select: { enabled: true } });
  return !!row?.enabled;
}

export async function status(subject: Subject): Promise<{ enabled: boolean; pending: boolean; confirmedAt: Date | null; recoveryRemaining: number }> {
  const row = await prisma.twoFactorSecret.findUnique({ where: uniqueWhere(subject), select: { enabled: true, confirmed_at: true } });
  const recoveryRemaining = row?.enabled
    ? await prisma.twoFactorRecoveryCode.count({ where: { ...where(subject), used_at: null } })
    : 0;
  return { enabled: !!row?.enabled, pending: !!row && !row.enabled, confirmedAt: row?.confirmed_at ?? null, recoveryRemaining };
}

/**
 * Start enrolment: mint a fresh secret in a DISABLED row and return it + the otpauth URI to QR. Refuses
 * if 2FA is already enabled (disable first) — we never silently replace a working secret. A prior
 * *pending* (unconfirmed) secret is overwritten, so re-scanning is fine.
 */
export async function beginEnrolment(subject: Subject, account: string): Promise<{ secret: string; otpauthUri: string }> {
  const existing = await prisma.twoFactorSecret.findUnique({ where: uniqueWhere(subject), select: { enabled: true } });
  if (existing?.enabled) throw new Error('2FA is already enabled — disable it before re-enrolling.');
  const secret = generateSecret();
  await prisma.twoFactorSecret.upsert({
    where: uniqueWhere(subject),
    create: { ...where(subject), secret, enabled: false },
    update: { secret, enabled: false, confirmed_at: null },
  });
  return { secret, otpauthUri: otpauthURI({ secret, issuer: issuerFor(subject.type), account }) };
}

/**
 * Confirm enrolment: verify a live code against the pending secret; only then flip enabled=true and mint
 * the recovery codes (returned ONCE, stored hashed). Returns null if the code is wrong — 2FA stays off.
 */
export async function confirmEnrolment(subject: Subject, code: string): Promise<{ recoveryCodes: string[] } | null> {
  const row = await prisma.twoFactorSecret.findUnique({ where: uniqueWhere(subject) });
  if (!row || row.enabled) return null; // nothing pending to confirm
  // EXPLICIT, because the compiler will not do it for us: `secret` became nullable when the sms
  // method was added, and lib/db exports `prisma` as `any` (globalForPrisma is any, which widens the
  // whole ?? expression), so NO Prisma access in this codebase is type-checked. A null secret here
  // would reach base32Decode and throw a 500 on a login screen.
  if (!row.secret) return null; // an sms-method row has no secret to confirm a TOTP against
  if (!verifyTotp(row.secret, code)) return null; // the round-trip failed — DO NOT enable
  const recoveryCodes = Array.from({ length: RECOVERY_COUNT }, makeRecoveryCode);
  await prisma.$transaction([
    prisma.twoFactorSecret.update({ where: uniqueWhere(subject), data: { enabled: true, confirmed_at: new Date() } }),
    prisma.twoFactorRecoveryCode.deleteMany({ where: where(subject) }),
    prisma.twoFactorRecoveryCode.createMany({ data: recoveryCodes.map((c) => ({ ...where(subject), code_hash: sha256(normaliseRecovery(c)) })) }),
  ]);
  return { recoveryCodes };
}

/**
 * The login second factor: a valid TOTP, OR an unused recovery code (which is then consumed). Returns
 * the method used, or ok:false. Recovery consumption is an atomic conditional update, so a code can
 * never be spent twice even under a race.
 */
export async function verifySecondFactor(subject: Subject, code: string): Promise<{ ok: boolean; method: 'totp' | 'recovery' | null; lockedOut?: boolean }> {
  const row = await prisma.twoFactorSecret.findUnique({ where: uniqueWhere(subject), select: { enabled: true, secret: true } });
  if (!row?.enabled) return { ok: false, method: null };

  // CHECKED BEFORE THE COMPARISON, so a locked-out attacker learns nothing from timing or outcome.
  if (await isLockedOut(subject)) return { ok: false, method: null, lockedOut: true };

  // Guarded explicitly — see confirmEnrolment. A row with no secret is an sms-method enrolment; it
  // simply has no TOTP to check, and falls through to the recovery-code branch below.
  if (row.secret && verifyTotp(row.secret, code)) { await clearFailures(subject); return { ok: true, method: 'totp' }; }
  const hash = sha256(normaliseRecovery(code));
  if (normaliseRecovery(code).length >= 8) {
    const consumed = await prisma.twoFactorRecoveryCode.updateMany({
      where: { ...where(subject), code_hash: hash, used_at: null }, data: { used_at: new Date() },
    });
    if (consumed.count === 1) { await clearFailures(subject); return { ok: true, method: 'recovery' }; }
  }
  const lockedOut = await recordFailure(subject);
  return { ok: false, method: null, lockedOut };
}

/**
 * The counter, on the SAME AuthRateLimit table the rest of auth uses — no new infra for one feature.
 *
 * AVAILABILITY STANCE, stated because it differs per direction: a counting error ALLOWS the attempt
 * (matching lib/auth-rate-limit — a limiter outage must not lock every user out of their own
 * account), while a successfully-counted overflow REFUSES. Errors here are rare and an attacker
 * cannot induce them, so 5-in-15-minutes still ends an online brute force long before 500,000 tries.
 */
async function isLockedOut(subject: Subject): Promise<boolean> {
  const since = new Date(Date.now() - TWO_FACTOR_LOCKOUT_MINUTES * 60 * 1000);
  try {
    return (await prisma.authRateLimit.count({ where: { key: failKey(subject), created_at: { gte: since } } })) >= TWO_FACTOR_MAX_FAILURES;
  } catch { return false; }
}

/** Record one failure; returns TRUE when that failure was the one that tripped the lockout. */
async function recordFailure(subject: Subject): Promise<boolean> {
  try {
    await prisma.authRateLimit.create({ data: { key: failKey(subject) } });
    return await isLockedOut(subject);
  } catch { return false; }
}

/** A correct code wipes the slate — five fat-fingered attempts across a week must not accumulate. */
async function clearFailures(subject: Subject): Promise<void> {
  await prisma.authRateLimit.deleteMany({ where: { key: failKey(subject) } }).catch(() => {});
}

/** Remaining failures before lockout, for a status panel. Never used as a gate — isLockedOut is. */
export async function failuresRemaining(subject: Subject): Promise<number> {
  const since = new Date(Date.now() - TWO_FACTOR_LOCKOUT_MINUTES * 60 * 1000);
  try {
    const used = await prisma.authRateLimit.count({ where: { key: failKey(subject), created_at: { gte: since } } });
    return Math.max(0, TWO_FACTOR_MAX_FAILURES - used);
  } catch { return TWO_FACTOR_MAX_FAILURES; }
}

/**
 * Turn 2FA off and wipe the secret + recovery codes — the disable and the owner-reset both land here.
 *
 * NOTE it deletes the WHOLE row, which also removes any verified phone stored on it. That is right
 * for a change of identity (nothing bound to the old one should survive) and WRONG for merely
 * clearing a number — use clearVerifiedPhone in lib/phone-verification for that, which nulls the
 * phone fields and leaves a TOTP enrolment intact.
 */
export async function disable(subject: Subject, db?: Db): Promise<void> {
  await clearFailures(subject); // a reset must not hand back an account that is still locked out
  // TRANSACTION-AWARE. A caller already inside a transaction — changing a login email, where the
  // identity change and the credentials it unbinds must land together or not at all — passes its
  // client in; nesting $transaction would throw. Without a client we own the atomicity ourselves.
  if (db) {
    await db.twoFactorRecoveryCode.deleteMany({ where: where(subject) });
    await db.twoFactorSecret.deleteMany({ where: where(subject) });
    return;
  }
  await prisma.$transaction([
    prisma.twoFactorRecoveryCode.deleteMany({ where: where(subject) }),
    prisma.twoFactorSecret.deleteMany({ where: where(subject) }),
  ]);
}
export const resetTwoFactor = disable; // owner-reset is the same teardown, just triggered by another actor
