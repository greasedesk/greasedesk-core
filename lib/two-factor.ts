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
import { prisma } from '@/lib/db';
import { generateSecret, verifyTotp, otpauthURI, base32Encode } from '@/lib/totp';

export type SubjectType = 'operator' | 'tenant' | 'rep';
export type Subject = { type: SubjectType; id: string };
const where = (s: Subject) => ({ subject_type: s.type, subject_id: s.id });
const uniqueWhere = (s: Subject) => ({ subject_type_subject_id: { subject_type: s.type, subject_id: s.id } });

export const TOTP_ISSUER = 'GreaseDesk Engine Room';
const RECOVERY_COUNT = 10;

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
  return { secret, otpauthUri: otpauthURI({ secret, issuer: TOTP_ISSUER, account }) };
}

/**
 * Confirm enrolment: verify a live code against the pending secret; only then flip enabled=true and mint
 * the recovery codes (returned ONCE, stored hashed). Returns null if the code is wrong — 2FA stays off.
 */
export async function confirmEnrolment(subject: Subject, code: string): Promise<{ recoveryCodes: string[] } | null> {
  const row = await prisma.twoFactorSecret.findUnique({ where: uniqueWhere(subject) });
  if (!row || row.enabled) return null; // nothing pending to confirm
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
export async function verifySecondFactor(subject: Subject, code: string): Promise<{ ok: boolean; method: 'totp' | 'recovery' | null }> {
  const row = await prisma.twoFactorSecret.findUnique({ where: uniqueWhere(subject), select: { enabled: true, secret: true } });
  if (!row?.enabled) return { ok: false, method: null };
  if (verifyTotp(row.secret, code)) return { ok: true, method: 'totp' };
  const hash = sha256(normaliseRecovery(code));
  if (normaliseRecovery(code).length >= 8) {
    const consumed = await prisma.twoFactorRecoveryCode.updateMany({
      where: { ...where(subject), code_hash: hash, used_at: null }, data: { used_at: new Date() },
    });
    if (consumed.count === 1) return { ok: true, method: 'recovery' };
  }
  return { ok: false, method: null };
}

/** Turn 2FA off and wipe the secret + recovery codes — the disable and the owner-reset both land here. */
export async function disable(subject: Subject): Promise<void> {
  await prisma.$transaction([
    prisma.twoFactorRecoveryCode.deleteMany({ where: where(subject) }),
    prisma.twoFactorSecret.deleteMany({ where: where(subject) }),
  ]);
}
export const resetTwoFactor = disable; // owner-reset is the same teardown, just triggered by another actor
