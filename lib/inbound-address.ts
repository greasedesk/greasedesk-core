/**
 * File: lib/inbound-address.ts
 * THE inbound address scheme. Minting, formatting and parsing in one place, so the address the
 * product hands out and the address it parses can never diverge.
 *
 *     <tenantToken>.<threadToken>@in.greasedesk.com
 *
 * ── WHY TWO TOKENS, BOTH RANDOM ─────────────────────────────────────────────────────────────────
 * NEITHER is derived from the tenant ref or from Group.id, and that is the whole point:
 *   • `ref` (GB-GD2141) is SEQUENTIALLY ALLOCATED. The live tenants run GD1967, GD2141, GD2175-2179.
 *     Anyone could walk GB-GD1000…9999 and post into every garage's customer threads.
 *   • `Group.id` is unguessable (uuid v4, ~122 bits) but NOT ROTATABLE — a leaked or spam-flooded
 *     address could not be changed without changing a primary key.
 * A dedicated random token is both unguessable and replaceable. 16 chars over a 32-symbol alphabet
 * ≈ 80 bits, which is not brute-forceable through an SMTP front door.
 *
 * ── WHY THE THREAD TOKEN EXISTS AT ALL ──────────────────────────────────────────────────────────
 * Sender address alone is not enough. It happens to be unambiguous on today's data (0 shared
 * addresses, 0 cross-tenant, 0 addresses mapping to two threads) but that is an ARTEFACT: the import
 * created ~one customer per vehicle, so nobody yet owns two cars. A thread is keyed on
 * (customer, vehicle), so the first customer with two vehicles maps one address to two threads and
 * sender-alone becomes ambiguous by construction. The token makes resolution exact today and keeps
 * it exact then.
 *
 * The MX host is a SUBDOMAIN, never the root: greasedesk.com's MX points at Microsoft 365, and an
 * MX on the root would route the company's own mail into this product.
 */
import crypto from 'crypto';

/** Lowercase, digits, no vowels-or-lookalikes that turn a read-aloud address into a support call. */
const ALPHABET = '23456789abcdefghjkmnpqrstuvwxyz';
const TOKEN_LEN = 16;

export const INBOUND_HOST = process.env.INBOUND_EMAIL_HOST || 'in.greasedesk.com';

/** A fresh token. Rejection-free: 31 symbols indexed from a byte, modulo bias is negligible at 80 bits. */
export function mintToken(len = TOKEN_LEN): string {
  const bytes = crypto.randomBytes(len);
  let out = '';
  for (let i = 0; i < len; i++) out += ALPHABET[bytes[i] % ALPHABET.length];
  return out;
}

const TOKEN_RE = new RegExp(`^[${ALPHABET}]{8,32}$`);
export const isToken = (v: unknown): v is string => typeof v === 'string' && TOKEN_RE.test(v);

/** The address for a specific conversation. Both halves present = exact resolution. */
export function threadAddress(tenantToken: string, threadToken: string): string {
  return `${tenantToken}.${threadToken}@${INBOUND_HOST}`;
}

/** The tenant's general address — no thread. Used as a reply-to where no conversation exists yet
 *  (an invoice email), and as the catch-all a customer might reply to from an old message. */
export function tenantAddress(tenantToken: string): string {
  return `${tenantToken}@${INBOUND_HOST}`;
}

export type ParsedInbound = { tenantToken: string | null; threadToken: string | null };

/**
 * Parse a recipient address back into its tokens. Returns nulls rather than throwing — an address we
 * do not recognise is a message to file in the unresolved bucket, not an exception.
 * Tolerates plus-addressing and case, and ignores anything that isn't our host.
 */
export function parseInboundAddress(address: string | null | undefined): ParsedInbound {
  const none: ParsedInbound = { tenantToken: null, threadToken: null };
  const raw = String(address ?? '').trim().toLowerCase();
  // Accept "Name <addr>" as well as a bare address.
  const addr = raw.includes('<') ? (raw.match(/<([^>]+)>/)?.[1] ?? raw) : raw;
  const at = addr.lastIndexOf('@');
  if (at < 1) return none;
  const host = addr.slice(at + 1);
  if (host !== INBOUND_HOST.toLowerCase()) return none;
  // Strip any +tag before splitting on the dot.
  const local = addr.slice(0, at).split('+')[0];
  const parts = local.split('.');
  if (parts.length === 1) return { tenantToken: isToken(parts[0]) ? parts[0] : null, threadToken: null };
  if (parts.length === 2) {
    return {
      tenantToken: isToken(parts[0]) ? parts[0] : null,
      threadToken: isToken(parts[1]) ? parts[1] : null,
    };
  }
  return none;
}

/** Every address on a webhook's to/cc/received_for that belongs to us, in preference order. */
export function pickOurAddresses(candidates: Array<string | null | undefined>): ParsedInbound[] {
  const parsed = candidates.map(parseInboundAddress).filter((p) => p.tenantToken || p.threadToken);
  // A message carrying a thread token is more specific than one carrying only a tenant token.
  return parsed.sort((a, b) => Number(!!b.threadToken) - Number(!!a.threadToken));
}
