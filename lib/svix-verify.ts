/**
 * File: lib/svix-verify.ts
 * Svix webhook signature verification over node:crypto — the scheme Resend uses for its webhooks.
 *
 * Hand-rolled rather than pulling the `svix` package, following the precedent set by lib/totp
 * (RFC 6238 over node:crypto): a verification path this project must be able to reason about in
 * full is worth more than a dependency, and the scheme is twelve lines.
 *
 * THE SCHEME
 *   headers:  svix-id, svix-timestamp, svix-signature
 *   secret:   "whsec_<base64>" — the base64 part is the raw HMAC key
 *   signed:   `${svix-id}.${svix-timestamp}.${rawBody}`
 *   sig:      base64(HMAC-SHA256(key, signedContent)), sent as a space-separated list of
 *             "v1,<sig>" entries so a secret can be rotated with both live at once.
 *
 * TWO THINGS THAT MUST NOT BE GOT WRONG
 *   1. RAW BYTES. The signature covers the body exactly as sent; a parsed-and-restringified body
 *      differs by whitespace and fails. The route disables the body parser for this reason.
 *   2. TIMING-SAFE COMPARISON. A plain === leaks the signature a byte at a time under timing
 *      analysis. crypto.timingSafeEqual, on equal-length buffers, is the whole defence.
 */
import crypto from 'crypto';

/** Svix's own default: reject anything more than five minutes either side of now. */
export const TOLERANCE_SECONDS = 5 * 60;

export type VerifyResult =
  | { ok: true; svixId: string; timestamp: number }
  | { ok: false; reason: string };

function timingSafeEq(a: string, b: string): boolean {
  // Uint8Array rather than Buffer: TS's Buffer generic and node:crypto's ArrayBufferView disagree
  // under this lib config, and casting to `any` on a comparison that IS the security control is
  // exactly where not to do it.
  const ab = new Uint8Array(Buffer.from(a, 'utf8'));
  const bb = new Uint8Array(Buffer.from(b, 'utf8'));
  // Length is not secret; comparing unequal lengths would throw, so check it first and cheaply.
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

export function verifySvixSignature(args: {
  rawBody: Buffer | string;
  svixId: string | undefined;
  svixTimestamp: string | undefined;
  svixSignature: string | undefined;
  secret: string;
  nowSeconds?: number;
}): VerifyResult {
  const { svixId, svixTimestamp, svixSignature, secret } = args;
  if (!svixId || !svixTimestamp || !svixSignature) return { ok: false, reason: 'missing svix headers' };

  const ts = Number(svixTimestamp);
  if (!Number.isFinite(ts)) return { ok: false, reason: 'bad timestamp' };
  const now = args.nowSeconds ?? Math.floor(Date.now() / 1000);
  // REPLAY WINDOW. A valid payload captured off the wire stays valid forever without this.
  if (Math.abs(now - ts) > TOLERANCE_SECONDS) return { ok: false, reason: 'timestamp outside tolerance' };

  const keyB64 = secret.startsWith('whsec_') ? secret.slice('whsec_'.length) : secret;
  let key: Uint8Array;
  try { key = new Uint8Array(Buffer.from(keyB64, 'base64')); } catch { return { ok: false, reason: 'bad secret' }; }
  if (!key.length) return { ok: false, reason: 'bad secret' };

  const body = typeof args.rawBody === 'string' ? args.rawBody : args.rawBody.toString('utf8');
  const signed = `${svixId}.${svixTimestamp}.${body}`;
  const expected = crypto.createHmac('sha256', key).update(signed).digest('base64');

  // The header carries a SPACE-SEPARATED LIST so a rotating secret can have two live signatures.
  // Any one match is a pass; the version prefix is stripped before comparing.
  const presented = svixSignature.split(' ').map((p) => (p.includes(',') ? p.split(',')[1] : p)).filter(Boolean);
  for (const p of presented) if (timingSafeEq(p, expected)) return { ok: true, svixId, timestamp: ts };
  return { ok: false, reason: 'signature mismatch' };
}

/** Sign a payload the way Svix would — used by the gate to prove the verifier accepts a good
 *  signature and rejects a tampered one. Not used by any product path. */
export function signSvixForTest(rawBody: string, svixId: string, timestamp: number, secret: string): string {
  const keyB64 = secret.startsWith('whsec_') ? secret.slice('whsec_'.length) : secret;
  const key = new Uint8Array(Buffer.from(keyB64, 'base64'));
  return `v1,${crypto.createHmac('sha256', key).update(`${svixId}.${timestamp}.${rawBody}`).digest('base64')}`;
}
