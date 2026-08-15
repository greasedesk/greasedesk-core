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
 *   • bound to ONE job card AND ONE purpose (a quote link cannot open the portal, or another card),
 *     and for invoice_pay to ONE frozen invoice as well
 *   • short-lived, and an expired link EXPLAINS itself rather than 404ing (a 404 reads as "broken").
 *     14 days for a quote; an invoice's window is derived from its due date — see invoicePayExpiry
 *   • revocable (revoked_at) when a card is cancelled or it went to the wrong address
 *   • every use recorded (consumed_at = first, use_count/last_used_at = all)
 *   • rate-limited on verification, so the token space cannot be walked
 *
 * ── THE RULE (amended 2026-08-15) ───────────────────────────────────────────────────────────────
 * A magic link must NEVER authorise a movement that REMOVES VALUE from the customer or the garage,
 * and never a destructive action. A payment TOWARD a frozen, named invoice is permitted.
 *
 * The rule used to read "never a money movement", full stop. That was written when the only money
 * on a link was hypothetical, and taken literally it forbids the one thing a customer most wants to
 * do with an invoice. It is amended rather than quietly worked around, because the reasoning is
 * what makes the amendment safe and the next person needs to be able to check it.
 *
 * THE ASYMMETRY. The whole security model here is that the holder of the link may not be the
 * customer. That is what makes a REMOVAL dangerous: a stranger cancelling a debt, changing a bank
 * detail, refunding to their own card, or deleting a job is a stranger taking something. Paying
 * runs the other way. Money moves toward the garage, against a document whose amount and payee
 * were frozen before the link existed and which the link cannot alter. A stranger who pays
 * someone else's invoice has harmed nobody and cannot get the money back through this surface.
 * The direction of travel, not the presence of money, is what the rule turns on.
 *
 * WHAT IS ACTUALLY EXPOSED, stated so it is not discovered later:
 *   • CARD TESTING. A pay endpoint is a card-testing target. The charge lands on the GARAGE's own
 *     Stripe account, where Stripe Radar is the real defence and the garage's own rules apply; we
 *     rate-limit at our endpoint so we are not the cheap way in. Not eliminated — owned, and owned
 *     by the party Stripe already holds responsible.
 *   • INVOICE CONTENTS. A leaked pay link shows what was billed. That is not a new exposure:
 *     portal_view exists to show a customer their job card and its invoice, by design, on the same
 *     credential. invoice_pay widens WHO might see one document, never WHAT the class of link can
 *     reveal.
 * Everything else — refunds, voids, bank details, amending the document — stays firmly on the
 * garage's authenticated side, where removals belong.
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
import type { PrismaClient, Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import { hashToken } from '@/lib/tokens';
import { takeToken } from '@/lib/auth-rate-limit';

type Db = PrismaClient | Prisma.TransactionClient;

export const MAGIC_LINK_DAYS = 14;

/**
 * ── HOW LONG A PAY LINK LIVES ───────────────────────────────────────────────────────────────────
 * 14 days is right for a quote — an offer that should be answered while it is still the price. It
 * is wrong for an invoice on terms: a 30-day account invoice would have a dead link five days
 * before the money was even due, and a garage chasing at day 25 would find the link they sent had
 * expired mid-chase.
 *
 * The rule: 30 days past the DUE DATE, floored at the usual 14 from now.
 *   • due_date set (account customers) → due + 30, so the chase window outlives the debt
 *   • due_date NULL → issue + 30. This is the COMMON path, not the edge: due_date is only frozen
 *     at mint for account customers, so an ordinary invoice has none and NULL there is honest —
 *     "no agreed terms", not "missing".
 *   • the floor matters because both bases can be in the PAST. Re-sending a three-month-old
 *     invoice must not mint a link that is already dead; max() with now + 14 makes every freshly
 *     minted link usable for at least a fortnight, whatever it is for.
 */
export const INVOICE_PAY_GRACE_DAYS = 30;

const DAY_MS = 24 * 60 * 60 * 1000;

export function invoicePayExpiry(
  args: { dueDate: Date | null; issuedAt: Date },
  now: Date = new Date(),
): Date {
  const base = args.dueDate ?? args.issuedAt;
  const graced = base.getTime() + INVOICE_PAY_GRACE_DAYS * DAY_MS;
  const floor = now.getTime() + MAGIC_LINK_DAYS * DAY_MS;
  return new Date(Math.max(graced, floor));
}

/**
 * `portal_view` IS DELIBERATELY DARK. It is a valid stored purpose with no route: /c/[token]
 * refuses it in words rather than half-rendering a destination nobody has built. Wiring the
 * dispatcher is not the same as wiring every branch, and a switch arm that renders a blank page is
 * worse than one that says "not available".
 */
export type MagicPurpose = 'quote_view' | 'portal_view' | 'invoice_pay';

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
  /** REQUIRED for invoice_pay — the frozen invoice this link opens. Ignored for other purposes. */
  invoiceId?: string | null;
  /** Overrides the default lifetime. invoice_pay callers pass invoicePayExpiry(). */
  expiresAt?: Date;
}): Promise<CreatedMagicLink> {
  // A pay link with no invoice would resolve to a card and render the wrong money. Refuse at the
  // mint rather than let the resolver discover it later with a customer already looking at it.
  if (args.purpose === 'invoice_pay' && !args.invoiceId) {
    throw new Error('MAGIC:invoice_pay_requires_invoice');
  }
  const raw = newMagicToken();
  const expiresAt = args.expiresAt ?? new Date(Date.now() + MAGIC_LINK_DAYS * DAY_MS);
  const row = await prisma.customerMagicLink.create({
    data: {
      group_id: args.groupId,
      job_card_id: args.jobCardId,
      invoice_id: args.purpose === 'invoice_pay' ? args.invoiceId : null,
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
  | { ok: true; link: { id: string; groupId: string; jobCardId: string; invoiceId: string | null; purpose: MagicPurpose; recipient: string; expiresAt: Date } }
  // `revokedReason` rides along on the revoked branch only — the caller needs WHY to pick the
  // sentence, and undefined/null both mean "not recorded" and get the neutral one.
  | { ok: false; reason: 'not_found' | 'expired' | 'revoked' | 'wrong_purpose' | 'rate_limited'; revokedReason?: RevokeReason };

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
    select: { id: true, group_id: true, job_card_id: true, invoice_id: true, purpose: true, recipient: true, expires_at: true, revoked_at: true, revoked_reason: true },
  });
  if (!row) return { ok: false, reason: 'not_found' };
  if (row.revoked_at) return { ok: false, reason: 'revoked', revokedReason: (row.revoked_reason ?? null) as RevokeReason };
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
      id: row.id, groupId: row.group_id, jobCardId: row.job_card_id, invoiceId: row.invoice_id ?? null,
      purpose: row.purpose as MagicPurpose, recipient: row.recipient, expiresAt: row.expires_at,
    },
  };
}

/**
 * WHY a link was killed — the customer reads a different sentence for each, so this is not
 * bookkeeping. Kept as a union rather than an enum column: the set will grow, and an additive
 * string needs no migration to add a reason the renderer already has to default for anyway.
 *
 * NULL is a first-class member, not a gap. It means "revoked, cause not recorded" — every row
 * written before 2026-08-08, plus `in_progress` (ruling): a started job has no true reason word,
 * and "invoiced" would be a lie while "cancelled" would be a worse one.
 */
export type RevokeReason = 'superseded' | 'invoiced' | 'declined' | 'cancelled' | null;

/** Kill one link (sent to the wrong address). Idempotent. */
export async function revokeMagicLink(id: string, reason: RevokeReason): Promise<void> {
  await prisma.customerMagicLink.updateMany({
    where: { id, revoked_at: null },
    data: { revoked_at: new Date(), revoked_reason: reason },
  });
}

/**
 * Revoke every live link for a card — cancelled, hard-deleted, declined, or INVOICED.
 *
 * Takes an optional transaction client because the invoice mint calls it from inside the minting
 * transaction. Revoking outside that tx would kill a customer's live link for an invoice that then
 * rolled back: the work would still be quotable and the customer would hold a dead link to it.
 * The revoke belongs to the mint, so it commits or fails with it.
 */
export async function revokeMagicLinksForCard(jobCardId: string, reason: RevokeReason, db: Db = prisma): Promise<number> {
  const r = await db.customerMagicLink.updateMany({
    where: { job_card_id: jobCardId, revoked_at: null },
    data: { revoked_at: new Date(), revoked_reason: reason },
  });
  return r.count;
}
