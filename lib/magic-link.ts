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
 * TOKEN DISCIPLINE — identical to the operator invite (lib/tokens): 32 random bytes, the RAW token
 * travels only in the emailed URL, only its SHA-256 hash is stored. A DB leak yields nothing usable.
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
  const raw = crypto.randomBytes(32).toString('hex');
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
  if (!rawToken || !/^[a-f0-9]{64}$/i.test(rawToken)) return { ok: false, reason: 'not_found' };

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
