/**
 * File: lib/twilio-verify.ts
 * Twilio webhook signature verification over node:crypto — the sibling of lib/svix-verify, and
 * DELIBERATELY NOT A COPY OF IT. The two schemes differ in every particular that matters, and the
 * failure mode of getting it wrong is a silent "invalid signature" that looks like a config problem.
 *
 *                     Svix (Resend)                  Twilio
 *   signs             the RAW request body           the URL + SORTED form parameters
 *   hash              HMAC-SHA256                    HMAC-SHA1
 *   key               whsec_… webhook secret         the account's AUTH TOKEN
 *   body parser       must be OFF (raw bytes)        may be ON (we need parsed params)
 *
 * ── HMAC-SHA1 IS TWILIO'S DEFINED SCHEME. DO NOT "IMPROVE" IT. ──────────────────────────────────
 * SHA-1 is broken for collision resistance and that is irrelevant here: this is HMAC-SHA1, whose
 * security rests on the keyed construction rather than on the hash being collision-resistant, and
 * there is no known practical attack against it. More to the point, the algorithm is not ours to
 * choose — Twilio computes the signature it sends with SHA-1, so anything else simply never matches.
 * Changing it to SHA-256 would reject every genuine callback while looking like a security upgrade.
 *
 * ── THE SIGNED STRING ───────────────────────────────────────────────────────────────────────────
 *   1. the full callback URL, exactly as Twilio was configured with it (scheme, host, path, query)
 *   2. the POST parameters sorted alphabetically BY NAME
 *   3. each name and value appended with NO delimiters at all: `…urlFooA1BarB2`
 *   4. HMAC-SHA1 with the Auth Token, base64
 *   5. compared against the X-Twilio-Signature header
 *
 * ── WHY THE URL COMES FROM AN ENV VAR AND NOT FROM THE REQUEST ──────────────────────────────────
 * Reconstructing it from headers is the obvious move and it is a trap. Behind a proxy the URL Node
 * sees is not the public one: the protocol arrives in x-forwarded-proto, the host may carry a port,
 * and a trailing slash difference is invisible to read but changes the hash. Every one of those
 * fails as "invalid signature" with nothing to distinguish it from a wrong token — a genuinely bad
 * hour. Pinning the value makes the URL a thing you can SEE and compare against the Twilio console.
 */
import crypto from 'crypto';

export type TwilioVerifyResult = { ok: true } | { ok: false; reason: string };

/** Length is not secret; comparing unequal lengths would throw, so it is checked first and cheaply. */
function timingSafeEq(a: string, b: string): boolean {
  const ab = new Uint8Array(Buffer.from(a, 'utf8'));
  const bb = new Uint8Array(Buffer.from(b, 'utf8'));
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

/**
 * The exact string Twilio signed. Exported so a test can assert the construction directly, and so
 * anyone debugging a mismatch can print it beside what they expect rather than guessing.
 */
export function signedString(url: string, params: Record<string, string>): string {
  return Object.keys(params)
    .sort()                                   // alphabetical BY NAME — Twilio's rule, not insertion order
    .reduce((acc, k) => acc + k + params[k], url); // no separators between name and value, or between pairs
}

export function computeSignature(authToken: string, url: string, params: Record<string, string>): string {
  // The string is passed directly rather than as a Buffer: TS's Buffer generic and node:crypto's
  // BinaryLike disagree under this lib config (the same friction lib/svix-verify documents), and a
  // cast on the line that IS the security control is exactly where not to put one.
  return crypto.createHmac('sha1', authToken)  // SHA-1 BY SPECIFICATION — see the header note
    .update(signedString(url, params), 'utf8')
    .digest('base64');
}

/**
 * Verify a callback. `url` MUST be the configured public callback URL, byte-for-byte as it appears
 * in the Twilio console — see the header note on why it is not derived from the request.
 */
export function verifyTwilioSignature(args: {
  authToken: string;
  url: string;
  params: Record<string, string>;
  header: string | string[] | undefined;
}): TwilioVerifyResult {
  const provided = Array.isArray(args.header) ? args.header[0] : args.header;
  if (!provided) return { ok: false, reason: 'missing X-Twilio-Signature' };
  if (!args.authToken) return { ok: false, reason: 'no auth token configured' };
  if (!args.url) return { ok: false, reason: 'no callback URL configured' };
  const expected = computeSignature(args.authToken, args.url, args.params);
  return timingSafeEq(expected, provided) ? { ok: true } : { ok: false, reason: 'signature mismatch' };
}

/**
 * Flatten a parsed form body to the string map the signature is computed over. Twilio sends
 * application/x-www-form-urlencoded, so every value is already a string; an array here means a
 * repeated key, which Twilio does not send — taking the first is the conservative reading and keeps
 * the signature computable rather than throwing.
 */
export function formParams(body: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!body || typeof body !== 'object') return out;
  for (const [k, v] of Object.entries(body as Record<string, unknown>)) {
    if (v === undefined || v === null) continue;
    out[k] = Array.isArray(v) ? String(v[0]) : String(v);
  }
  return out;
}
