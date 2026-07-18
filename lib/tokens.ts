/**
 * File: lib/tokens.ts
 * Single-use invite / set-password tokens. We generate a high-entropy random token, email the
 * RAW token in the link, and store only its SHA-256 hash (deterministic → look-up-able; a DB
 * leak exposes only irreversible hashes). Single-use is enforced by a used_at flag; 5-day expiry.
 */
import crypto from 'crypto';

export const INVITE_TOKEN_DAYS = 5;

export function hashToken(raw: string): string {
  return crypto.createHash('sha256').update(raw).digest('hex');
}

export function makeInviteToken(): { raw: string; hash: string; expires: Date } {
  const raw = crypto.randomBytes(32).toString('hex');
  return {
    raw,
    hash: hashToken(raw),
    expires: new Date(Date.now() + INVITE_TOKEN_DAYS * 24 * 60 * 60 * 1000),
  };
}

/** Password-reset token — SHORT life (1 hour) and stored hashed, like the invite. Kept SEPARATE
 *  from the invite token on purpose: a reset is legitimately repeatable, an invite is not. */
export const RESET_TOKEN_MINUTES = 60;

export function makeResetToken(): { raw: string; hash: string; expires: Date } {
  const raw = crypto.randomBytes(32).toString('hex');
  return {
    raw,
    hash: hashToken(raw),
    expires: new Date(Date.now() + RESET_TOKEN_MINUTES * 60 * 1000),
  };
}
