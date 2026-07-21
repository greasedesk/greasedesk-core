/**
 * File: lib/totp.ts
 * TOTP (RFC 6238) over node:crypto — the crypto core of Engine Room 2FA, deliberately dependency-free
 * so the second-factor VERIFICATION path has no third-party code in it (the QR image is rendered by a
 * lib, but the QR only encodes a URI we also show as text, so it is never authoritative). Pure and
 * actor-agnostic: no DB, no wall-clock baked in (verify takes an optional `nowSec` so it is testable
 * against the RFC vectors). lib/two-factor is the DB-backed chokepoint that uses this.
 *
 * Standard authenticator settings: SHA1, 6 digits, 30s period — what Google Authenticator / 1Password /
 * Authy default to, so a stock app scans our otpauth:// URI and just works.
 */
import crypto from 'crypto';

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'; // RFC 4648 base32 alphabet

export function base32Encode(buf: Buffer): string {
  let bits = 0, value = 0, out = '';
  for (const byte of buf) {
    value = (value << 8) | byte; bits += 8;
    while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(s: string): Buffer {
  const clean = s.toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = 0, value = 0;
  const out: number[] = [];
  for (const c of clean) {
    const idx = B32.indexOf(c);
    if (idx < 0) continue;
    value = (value << 5) | idx; bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 0xff); bits -= 8; }
  }
  return Buffer.from(out);
}

/** A fresh base32 TOTP secret (default 20 random bytes = 160 bits, the RFC-recommended SHA1 key size). */
export function generateSecret(bytes = 20): string {
  return base32Encode(crypto.randomBytes(bytes));
}

/** HOTP (RFC 4226): the counter-based primitive TOTP is built on. */
function hotp(secret: string, counter: number, digits: number): string {
  const key = base32Decode(secret);
  const buf = Buffer.alloc(8);
  buf.writeUInt32BE(Math.floor(counter / 0x1_0000_0000), 0); // high word (0 for any realistic time)
  buf.writeUInt32BE(counter >>> 0, 4);                        // low word
  const hmac = crypto.createHmac('sha1', Uint8Array.from(key)).update(Uint8Array.from(buf)).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;               // dynamic truncation
  const bin = ((hmac[offset] & 0x7f) << 24) | ((hmac[offset + 1] & 0xff) << 16) |
              ((hmac[offset + 2] & 0xff) << 8) | (hmac[offset + 3] & 0xff);
  return (bin % 10 ** digits).toString().padStart(digits, '0');
}

export type TotpOpts = { digits?: number; period?: number };

/** The code for a given unix time (seconds) — what an authenticator app shows. */
export function totpAt(secret: string, timeSec: number, opts: TotpOpts = {}): string {
  const { digits = 6, period = 30 } = opts;
  return hotp(secret, Math.floor(timeSec / period), digits);
}

function timingSafeStrEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a), bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(Uint8Array.from(ba), Uint8Array.from(bb));
}

/**
 * True if `token` is valid for `secret` around now. `window` steps of clock-skew tolerance on each
 * side (default ±1 = ±30s). Timing-safe compare. nowSec is injectable for tests.
 */
export function verifyTotp(secret: string, token: string, opts: TotpOpts & { window?: number; nowSec?: number } = {}): boolean {
  const { digits = 6, period = 30, window = 1, nowSec } = opts;
  const clean = String(token || '').replace(/\D/g, '');
  if (clean.length !== digits) return false;
  const t = nowSec ?? Math.floor(Date.now() / 1000);
  const counter = Math.floor(t / period);
  for (let w = -window; w <= window; w++) {
    if (timingSafeStrEqual(hotp(secret, counter + w, digits), clean)) return true;
  }
  return false;
}

/** The otpauth:// URI a QR encodes. `issuer`/`account` show as the app's label. */
export function otpauthURI(args: { secret: string; issuer: string; account: string; digits?: number; period?: number }): string {
  const { secret, issuer, account, digits = 6, period = 30 } = args;
  const label = encodeURIComponent(`${issuer}:${account}`);
  const params = new URLSearchParams({ secret, issuer, algorithm: 'SHA1', digits: String(digits), period: String(period) });
  return `otpauth://totp/${label}?${params.toString()}`;
}
