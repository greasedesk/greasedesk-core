/**
 * File: lib/payee-crypto.ts
 * THE ONLY PLACE A BANK DETAIL IS ENCRYPTED OR DECRYPTED. AES-256-GCM, one key, one format.
 *
 * ── WHAT THIS PROTECTS, AND WHAT IT DOES NOT ────────────────────────────────────────────────────
 * It protects a DATABASE DUMP: a Neon branch handed to a gate, a stolen connection string, the
 * nightly backup sitting in R2. Those carry rows and not the environment, so ciphertext in them is
 * ciphertext.
 *
 * It does NOT protect against anybody holding the running application, which reads the key out of
 * the environment to answer a reveal. Said first and plainly, because an encrypted column invites
 * the belief that it covers more than it does, and a guard believed to be wider than it is is worse
 * than no guard — somebody stops thinking about the case it never covered.
 *
 * ── SERVER ONLY ─────────────────────────────────────────────────────────────────────────────────
 * It imports node:crypto. One module-scope reference from anything a page ships to the browser
 * drags that into the client bundle and 500s the page — the shape client-bundle-gate exists to
 * catch. Nothing that renders may import this file; the pages read `account_last4`, which is why
 * that column exists.
 *
 * ── IT FAILS CLOSED, IN BOTH DIRECTIONS ─────────────────────────────────────────────────────────
 * No key, or a key that is not exactly 32 bytes, and this REFUSES. It never stores plaintext as a
 * fallback and never returns ciphertext as though it were a number. A bank detail we cannot encrypt
 * is a bank detail we do not take.
 */
import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from 'node:crypto';

/** The env var, named once so an error message and a setup check cannot disagree about it. */
export const PAYEE_KEY_ENV = 'PAYEE_ENC_KEY';

/**
 * THE FORMAT, VERSIONED FROM THE FIRST ROW. `v1:<iv>:<tag>:<ciphertext>`, each part base64.
 *
 * A version prefix on day one costs four characters and buys the ability to re-key later without
 * guessing which rows are which. It is also what makes the legacy branch below decidable rather
 * than a heuristic about what a sort code looks like.
 */
export const PAYEE_ENC_PREFIX = 'v1';

const KEY_BYTES = 32; // AES-256. Not negotiable by configuration — a shorter key is an error.
const IV_BYTES = 12;  // GCM's own recommendation; 96 bits is the size the mode is specified for.

/** Thrown when the key is missing or malformed. Its own class so a caller can tell it apart. */
export class PayeeKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PayeeKeyError';
  }
}

/** Thrown when stored ciphertext cannot be read back — wrong key, or a tampered row. */
export class PayeeCipherError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PayeeCipherError';
  }
}

/**
 * THE KEY, DECODED AND CHECKED EVERY TIME.
 *
 * NOT CACHED AT MODULE SCOPE. A cached key is read once, at import, which in a long-lived serverless
 * instance means the first request after a key rotation decides the behaviour of every later one —
 * and makes a gate that sets the variable per clause depend on import order. The decode is
 * microseconds; the confusion is not.
 *
 * ERRORS NAME THE WRONG CONCLUSION. "PAYEE_ENC_KEY is not set" sends somebody to the dashboard to
 * look for a bug in the form, so each message says what to do instead.
 */
function payeeKey(): Buffer {
  const raw = (process.env[PAYEE_KEY_ENV] ?? '').trim();
  if (!raw) {
    throw new PayeeKeyError(
      `${PAYEE_KEY_ENV} is not set, so bank details cannot be stored or read. This is not a fault in the form: `
      + `set it (base64 of 32 random bytes, e.g. \`openssl rand -base64 32\`) in .env for local and gate runs, `
      + 'and in Vercel for production. It is deliberately a different value in each.',
    );
  }
  const key = Buffer.from(raw, 'base64');
  if (key.length !== KEY_BYTES) {
    throw new PayeeKeyError(
      `${PAYEE_KEY_ENV} decodes to ${key.length} bytes, and AES-256 needs exactly ${KEY_BYTES}. `
      + 'It is NOT hashed or padded to fit, because a key silently stretched from a short string is a key '
      + `nobody can reproduce. Generate a real one: \`openssl rand -base64 ${KEY_BYTES}\`.`,
    );
  }
  return key;
}

/**
 * IS A USABLE KEY PRESENT? For a setup screen and for a gate's premise, so neither has to provoke a
 * throw to find out. Returns false for both failures — absent and malformed — because the question
 * callers ask is "can I take bank details", and the answer to that is no either way.
 */
export function payeeKeyUsable(): boolean {
  try {
    payeeKey();
    return true;
  } catch {
    return false;
  }
}

/** Does this stored value carry our envelope? The decidable test the legacy branch turns on. */
export function isPayeeEncrypted(stored: string | null | undefined): boolean {
  return typeof stored === 'string' && stored.startsWith(`${PAYEE_ENC_PREFIX}:`);
}

/**
 * ENCRYPT. A fresh IV per value, never derived from the plaintext: two reps with the same sort code
 * must not produce the same ciphertext, or the column leaks equality for free.
 */
export function encryptPayee(plain: string): string {
  const value = String(plain ?? '');
  if (!value) throw new PayeeCipherError('refusing to encrypt an empty value — store NULL instead, which means "we hold none"');
  const iv = randomBytes(IV_BYTES);
  // Uint8Array.from at the call site, the idiom lib/totp.ts already uses: @types/node types these
  // parameters as Uint8Array and a Buffer is not assignable to it under this tsconfig.
  const cipher = createCipheriv('aes-256-gcm', Uint8Array.from(payeeKey()), Uint8Array.from(iv));
  const ct = Buffer.concat([Uint8Array.from(cipher.update(value, 'utf8')), Uint8Array.from(cipher.final())]);
  return [PAYEE_ENC_PREFIX, iv.toString('base64'), cipher.getAuthTag().toString('base64'), ct.toString('base64')].join(':');
}

/**
 * DECRYPT — and this is the one place a REVEAL happens, so every caller of it is a caller that must
 * be owner-gated and audited. There is no "peek" variant on purpose.
 *
 * ── THE LEGACY BRANCH IS TEMPORARY AND IS WRITTEN DOWN AS SUCH ──────────────────────────────────
 * A value with no `v1:` prefix is returned UNCHANGED. That is how plaintext written before this
 * module existed stays readable while the one-off re-encrypt is still to be run, and it is what
 * makes the order of apply / deploy / re-encrypt not matter.
 *
 * IT IS ALSO A HOLE WITH A PREMISE THAT EXPIRES. Once scripts/encrypt-rep-bank.mjs has run against
 * a database, nothing in it should be plaintext again, and this branch would then only ever be
 * reached by a row somebody wrote around the chokepoint. Delete it at that point; payee-gate
 * asserts no stored value is plaintext, so the branch becomes unreachable before it becomes wrong.
 */
export function decryptPayee(stored: string): string {
  const value = String(stored ?? '');
  if (!value) throw new PayeeCipherError('nothing to decrypt — an absent value is NULL, not an empty string');
  if (!isPayeeEncrypted(value)) return value; // legacy plaintext — see the header
  const [, ivB64, tagB64, ctB64] = value.split(':');
  if (!ivB64 || !tagB64 || !ctB64) {
    throw new PayeeCipherError(`stored value claims ${PAYEE_ENC_PREFIX} but is not iv:tag:ciphertext — the row is damaged, not the key`);
  }
  try {
    const decipher = createDecipheriv('aes-256-gcm', Uint8Array.from(payeeKey()), Uint8Array.from(Buffer.from(ivB64, 'base64')));
    decipher.setAuthTag(Uint8Array.from(Buffer.from(tagB64, 'base64')));
    const out = decipher.update(Uint8Array.from(Buffer.from(ctB64, 'base64')));
    return Buffer.concat([Uint8Array.from(out), Uint8Array.from(decipher.final())]).toString('utf8');
  } catch (e) {
    if (e instanceof PayeeKeyError) throw e; // a missing key is not a damaged row; keep them apart
    throw new PayeeCipherError(
      'this value will not decrypt with the key in this environment. The likelier cause is the WRONG KEY — '
      + 'the gate key and the production key are deliberately different — not a corrupted row.',
    );
  }
}

/** Digits only. What a person types has spaces and dashes in it; what we compare and store does not. */
export const payeeDigits = (raw: string | null | undefined): string => String(raw ?? '').replace(/\D+/g, '');

/**
 * THE LAST FOUR, from whatever the person typed. Derived at write time and stored in clear, so the
 * affiliate's own "ending ••34" needs no key, writes no audit row, and cannot be the thing that
 * makes a dashboard load fail.
 *
 * REFUSES rather than padding a short number. '••12' built from a two-digit string would be a
 * plausible wrong value on a screen about money, which outlives an implausible one.
 */
export function payeeLast4(accountNumber: string): string {
  const d = payeeDigits(accountNumber);
  if (d.length < 4) throw new PayeeCipherError(`cannot take the last four digits of ${d.length} — refusing to pad`);
  return d.slice(-4);
}

/**
 * Are these two the same account? Compared on DIGITS, in constant time, so the Engine Room can say
 * "this is the same account you already hold" without the comparison itself leaking the answer by
 * how long it took.
 */
export function sameAccount(a: string, b: string): boolean {
  const x = Buffer.from(payeeDigits(a));
  const y = Buffer.from(payeeDigits(b));
  return x.length === y.length && x.length > 0 && timingSafeEqual(Uint8Array.from(x), Uint8Array.from(y));
}
