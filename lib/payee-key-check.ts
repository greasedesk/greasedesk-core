/**
 * File: lib/payee-key-check.ts
 * WHICH PAYEE KEY BELONGS TO WHICH DATABASE — and the refusal when they disagree.
 *
 * ── THE HAZARD THIS CLOSES (owner, 2026-10-31) ──────────────────────────────────────────────────
 * Nothing could tell the gate key from the production key. Point a tool at production holding the
 * gate key and it encrypts real bank details with it, reports success, and leaves digits production
 * can never read again. No error, no exception, no way to notice afterwards — and no way to notice
 * BEFOREHAND either, because verifying a key needs something already encrypted with it, and a fresh
 * database has nothing.
 *
 * So the check value is registered IN CODE, per environment, and compared against the ENVIRONMENT
 * MARKER — a property of the database itself, which is the right axis: a database carrying real
 * tenants says `kind: 'production'`, whatever URL happens to be pointed at it.
 *
 * ── IT IS A FINGERPRINT, NOT A KEY, AND THAT IS WHY IT CAN LIVE HERE ────────────────────────────
 * 16 hex of HMAC-SHA256(key, label). One-way: recovering the key means brute-forcing 256 bits.
 * Committing it, printing it and reading it aloud are all safe. It must never be treated as a
 * secret, and the key itself must never appear in this file, in a log, or in a refusal message.
 *
 * ── IT FAILS CLOSED IN FOUR DIRECTIONS ──────────────────────────────────────────────────────────
 * No key, an unreadable marker, an environment with no registered fingerprint, and a mismatch all
 * REFUSE. "Not yet registered" refusing is deliberate: the alternative is a first deploy that
 * quietly encrypts the first real bank details with an unverified key, which is the whole thing
 * this exists to prevent. The cost is that the payee form answers 503 until the fingerprint is
 * committed, and that is the correct trade.
 */
import type { EnvironmentKind } from '@/lib/environment';
import { readEnvironment } from '@/lib/environment';
import { payeeKeyFingerprint, PayeeKeyError } from '@/lib/payee-crypto';

/**
 * THE REGISTER. One line per environment, and a null means NOT YET REGISTERED rather than "no key
 * needed" — three states, because "we have not done it" and "there is nothing to do" are different
 * and only one of them is safe.
 *
 *   test       — the key in .env on this machine and on the gate database.
 *   production — the key in Vercel (Production), registered by the owner on 2026-10-31.
 *
 * Either is computed from the key it belongs to WITHOUT the key reaching a file or the shell
 * history:
 *     read -rs PAYEE_ENC_KEY && export PAYEE_ENC_KEY \
 *       && node scripts/payee-key-fingerprint.mjs > /tmp/fp.log 2>&1; unset PAYEE_ENC_KEY
 * That script deliberately does not read .env, so forgetting to export refuses rather than
 * fingerprinting the gate key and letting it be registered as production's.
 *
 * ── THE TWO MUST DIFFER, AND A CLAUSE HOLDS THEM APART ─────────────────────────────────────────
 * The one mistake a fingerprint cannot catch for you is registering the SAME key for both: it would
 * match everywhere and check nothing. payee-gate asserts they differ, so a copy-paste of the gate
 * fingerprint into the production line goes red instead of quietly disabling the whole mechanism.
 */
export const PAYEE_KEY_FINGERPRINTS: Readonly<Record<EnvironmentKind, string | null>> = {
  test: '25607c7f6a3f0306',
  production: '72fc846dc8d958fd',
};

export type KeyRefusal = { code: string; message: string };

/**
 * THE PURE RULE, so a gate can ask it about every combination without a database and without
 * holding two keys at once.
 *
 * `fingerprint` is null when this process has no usable key at all — a different refusal from a
 * wrong one, and said differently, because the actions are different.
 */
export function refusePayeeKey(
  kind: EnvironmentKind | null,
  fingerprint: string | null,
  register: Readonly<Record<string, string | null>> = PAYEE_KEY_FINGERPRINTS,
): KeyRefusal | null {
  if (!fingerprint) {
    return {
      code: 'no_key',
      message: 'PAYEE_ENC_KEY is not set, or is not base64 of 32 bytes, so bank details cannot be '
        + 'encrypted or read. Nothing is stored in clear as a fallback.',
    };
  }
  if (!kind) {
    return {
      code: 'environment_unknown',
      message: 'This database does not say which environment it is, so the key cannot be checked against '
        + 'it. Refusing rather than guessing: the guess that costs something is the one that writes.',
    };
  }
  if (!(kind in register)) {
    return { code: 'environment_unregistered', message: `No payee key is registered for environment kind "${kind}".` };
  }
  const expected = register[kind];
  if (!expected) {
    return {
      code: 'fingerprint_unregistered',
      message: `No payee key fingerprint is registered for "${kind}" yet. The key in use has fingerprint `
        + `${fingerprint}. If that is the right key for this database, record it in `
        + 'lib/payee-key-check::PAYEE_KEY_FINGERPRINTS and deploy. Until then bank details are refused, '
        + 'deliberately — the alternative is encrypting the first real ones with a key nobody has checked.',
    };
  }
  if (expected !== fingerprint) {
    return {
      code: 'fingerprint_mismatch',
      // BOTH FINGERPRINTS, because they are check values and not secrets, and because "it does not
      // match" without saying what it is leaves somebody guessing which key they have in hand.
      message: `The PAYEE_ENC_KEY in use does not belong to this database. It fingerprints as ${fingerprint}; `
        + `a "${kind}" database expects ${expected}. This is the gate key against production, or the other way `
        + 'round. NOTHING has been read or written.',
    };
  }
  return null;
}

/**
 * THE GUARD THE CALLERS USE. Three of them — the affiliate's payee POST, the owner's reveal, and
 * the one-off script — and payee-gate sweeps for a fourth that forgets.
 *
 * It reads the marker (cached per process after the first read) and fingerprints the key in hand.
 * A missing key is caught here rather than thrown, so a caller gets a refusal to render instead of
 * a stack trace.
 */
export async function payeeKeyRefusal(db?: any): Promise<KeyRefusal | null> {
  let fingerprint: string | null = null;
  try {
    fingerprint = payeeKeyFingerprint();
  } catch (e) {
    if (!(e instanceof PayeeKeyError)) throw e;
    fingerprint = null;
  }
  const env = await readEnvironment(db);
  return refusePayeeKey(env.kind, fingerprint);
}
