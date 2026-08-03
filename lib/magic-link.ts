/**
 * File: lib/magic-link.ts
 * THE chokepoint for customer magic links. Customers have no account and never will for this flow —
 * the URL itself is the credential.
 *
 * ⚠️ SECURITY MODEL, STATED PLAINLY: anyone holding the link can view what it grants. There is no
 * password, no second factor, no proof the holder is the customer. A forwarded email, a shared phone,
 * a mail server that logs URLs — all confer access. This is a deliberate trade: customers will not
 * create accounts to look at a quote. The trade is made survivable by keeping the grant NARROW and
 * SHORT, never wide and permanent:
 *   • bound to ONE job card AND ONE purpose (a quote link cannot open the portal, or another card)
 *   • 14-day expiry, and an expired link EXPLAINS itself rather than 404ing (a 404 reads as "broken")
 *   • revocable (revoked_at) when a card is cancelled or it went to the wrong address
 *   • every use recorded (consumed_at = first, use_count/last_used_at = all)
 *   • rate-limited on verification, so the token space cannot be walked
 * A magic link must NEVER authorise a money movement or a destructive action. Read, and the one
 * bounded decision the purpose names (approve/decline a quote).
 *
 * TOKEN DISCIPLINE: the RAW token travels only in the URL, only its SHA-256 hash is stored. A DB
 * leak yields nothing usable.
 *
 * ── WHY 96 BITS, AND WHY SHORT (ruling 2026-08-02) ──────────────────────────────────────────────
 * This credential travels by SMS, where every character is billed. The old 64-hex token (256 bits)
 * made the URL 89 characters of a 160-character segment, so a quote SMS carrying TMBS's real
 * trading name and a four-figure total cost TWO segments — and a garage whose name contains a
 * curly apostrophe paid THREE, for a message a handset shows identically.
 *
 * 16 base64url characters = 96 bits, and the URL drops 89 → 41. The length was chosen so the
 * credential is safe WITH NO RATE LIMITING AT ALL: against 10,000 attacking IPs for the full 14-day
 * expiry, the expected number of hits on any live link is ~3e-20. That matters because the limiter
 * (lib/auth-rate-limit, 60/IP/hour) FAILS OPEN on a database error — a token whose safety depends
 * on it is not safe. At 96 bits the limiter is belt-and-braces; at 48 bits (8 chars) a botnet gets
 * inside the expiry window in under two days. base64url's alphabet is entirely GSM-7 safe, so the
 * shorter token costs nothing in encoding.
 *
 * The other randomBytes(32) tokens (lib/tokens ×2, register-garage) are DELIBERATELY unchanged —
 * they travel by email, where length is free and there is no reason to spend entropy.
 */
import crypto from 'crypto';
import { prisma } from '@/lib/db';
import { hashToken } from '@/lib/tokens';
import { takeToken } from '@/lib/auth-rate-limit';

export const MAGIC_LINK_DAYS = 14;

export type MagicPurpose = 'quote_view' | 'portal_view';

/** Verification rate limits — the token space is 2^256, but a limiter also blunts a leaked-link
 *  replay storm and keeps the log honest. Per-IP is the real axis (a token is a secret already). */
export const MAGIC_LIMITS = { perIp: { max: 60, windowMinutes: 60 } };

export type CreatedMagicLink = { id: string; rawToken: string; url: string; expiresAt: Date };

/** 12 random bytes → 16 base64url characters → 96 bits. See the header for why 96. */
export const MAGIC_TOKEN_CHARS = 16;
export function newMagicToken(): string {
  return crypto.randomBytes(12).toString('base64url');
}

/**
 * ACCEPTS BOTH SHAPES, deliberately. The validator is WIDENED, not swapped: links minted before
 * this change are 64 hex characters and are still live in customers' inboxes. Swapping the pattern
 * would have rejected them at the door, BEFORE hashing, so they would have read as "not found" —
 * a working credential turned into a broken link by a formatting rule.
 *
 * The old shape is a strict subset of the new character class, so this is a length test, not a
 * loosening: 64-hex tokens keep 256 bits, new tokens have 96, and nothing in between is minted.
 * The dual window closes by itself — the last old link expires 14 days after the last old mint.
 */
const MAGIC_TOKEN_RE = /^[A-Za-z0-9_-]{16}$|^[a-f0-9]{64}$/i;

/**
 * Mint a link. Returns the RAW token exactly once — it is never recoverable afterwards, so the caller
 * must send it immediately (or discard it and mint another).
 */
export async function createMagicLink(args: {
  groupId: string;
  jobCardId: string;
  purpose: MagicPurpose;
  recipient: string;
  createdByUserId?: string | null;
  baseUrl?: string;
}): Promise<CreatedMagicLink> {
  const raw = newMagicToken();
  const expiresAt = new Date(Date.now() + MAGIC_LINK_DAYS * 24 * 60 * 60 * 1000);
  const row = await prisma.customerMagicLink.create({
    data: {
      group_id: args.groupId,
      job_card_id: args.jobCardId,
      purpose: args.purpose,
      token_hash: hashToken(raw),
      expires_at: expiresAt,
      recipient: args.recipient,
      created_by_user: args.createdByUserId ?? null,
    },
    select: { id: true },
  });
  return { id: row.id, rawToken: raw, url: magicLinkUrl(raw, args.baseUrl), expiresAt };
}

export function magicLinkUrl(rawToken: string, baseUrl?: string): string {
  const base = baseUrl || process.env.NEXT_PUBLIC_APP_URL || process.env.NEXTAUTH_URL || 'https://greasedesk.com';
  return `${base.replace(/\/$/, '')}/c/${rawToken}`;
}

export type MagicResolution =
  | { ok: true; link: { id: string; groupId: string; jobCardId: string; purpose: MagicPurpose; recipient: string; expiresAt: Date } }
  | { ok: false; reason: 'not_found' | 'expired' | 'revoked' | 'wrong_purpose' | 'rate_limited' };

/**
 * Resolve a raw token. Distinguishes EXPIRED from NOT-FOUND deliberately: the customer holding a
 * three-week-old email must be told "this link has expired, ask the garage for a new one", not shown
 * a 404. The distinction leaks only that a token once existed — worthless without the token itself.
 */
export async function resolveMagicLink(
  rawToken: string,
  opts: { purpose?: MagicPurpose; ip?: string; recordUse?: boolean } = {},
): Promise<MagicResolution> {
  if (opts.ip) {
    const allowed = await takeToken(`magic:ip:${opts.ip}`, MAGIC_LIMITS.perIp.max, MAGIC_LIMITS.perIp.windowMinutes);
    if (!allowed) return { ok: false, reason: 'rate_limited' };
  }
  if (!rawToken || !MAGIC_TOKEN_RE.test(rawToken)) return { ok: false, reason: 'not_found' };

  const row = await prisma.customerMagicLink.findUnique({
    where: { token_hash: hashToken(rawToken) },
    select: { id: true, group_id: true, job_card_id: true, purpose: true, recipient: true, expires_at: true, revoked_at: true },
  });
  if (!row) return { ok: false, reason: 'not_found' };
  if (row.revoked_at) return { ok: false, reason: 'revoked' };
  if (row.expires_at.getTime() <= Date.now()) return { ok: false, reason: 'expired' };
  if (opts.purpose && row.purpose !== opts.purpose) return { ok: false, reason: 'wrong_purpose' };

  if (opts.recordUse !== false) {
    const now = new Date();
    await prisma.customerMagicLink
      .update({ where: { id: row.id }, data: { use_count: { increment: 1 }, last_used_at: now } })
      .catch(() => {});
    // consumed_at records the FIRST use only — set it separately so re-opens don't overwrite it.
    await prisma.customerMagicLink
      .updateMany({ where: { id: row.id, consumed_at: null }, data: { consumed_at: now } })
      .catch(() => {});
  }

  return {
    ok: true,
    link: {
      id: row.id, groupId: row.group_id, jobCardId: row.job_card_id,
      purpose: row.purpose as MagicPurpose, recipient: row.recipient, expiresAt: row.expires_at,
    },
  };
}

/** Kill a link (card cancelled, sent to the wrong address). Idempotent. */
export async function revokeMagicLink(id: string): Promise<void> {
  await prisma.customerMagicLink.updateMany({ where: { id, revoked_at: null }, data: { revoked_at: new Date() } });
}

/** Revoke every live link for a card — used when a card is cancelled or hard-deleted. */
export async function revokeMagicLinksForCard(jobCardId: string): Promise<number> {
  const r = await prisma.customerMagicLink.updateMany({
    where: { job_card_id: jobCardId, revoked_at: null },
    data: { revoked_at: new Date() },
  });
  return r.count;
}
