/**
 * File: lib/rep-magic-link.ts
 * THE chokepoint for rep sign-in links. A rep has no password and never will: the link IS the
 * credential, and the address it was sent to is the account.
 *
 * ── WHY THIS IS NOT lib/magic-link ──────────────────────────────────────────────────────────────
 * It reuses that module's PRIMITIVES — newMagicToken, hashToken, the rate limiter — and none of its
 * rules, because the two links are different instruments:
 *
 *   • A customer link is DELIBERATELY MULTI-USE. Its own header says so: "a customer re-opening the
 *     same email must still work". This one burns on first use, because it mints a session.
 *   • A customer link is bound to one job card and one purpose. A rep belongs to no garage and no
 *     job card; CustomerMagicLink.group_id and .job_card_id are NOT NULL and could not hold one.
 *   • A customer link is read-oriented. This one authenticates.
 *
 * ── THE STANDING RULE, AMENDED A SECOND TIME (2026-09-09) ───────────────────────────────────────
 * lib/magic-link's rule read: a magic link must never authorise a movement that REMOVES VALUE, and
 * (from 2026-08-15) a payment TOWARD a frozen invoice is permitted. Both amendments are written out
 * there rather than worked around here, and the reasoning for this one is:
 *
 * THIS IS THE FIRST LINK THAT CREATES A LIABILITY. A rep signing in can raise an invoice to us. No
 * value is removed from anybody — but something new is owed, which the old rule did not contemplate
 * in either direction. What makes it safe is not the direction of travel this time; it is WHO THE
 * HOLDER IS. A customer link is sent to somebody with no account, and the whole model assumes the
 * holder may not be the customer. A rep link is sent to an address an OPERATOR set, on a person we
 * have contracted with, which a rep can never change themselves. The mailbox is the account by
 * design, not by accident — so "whoever holds the link" and "the rep" are the same claim, and
 * treating them as one is the model rather than a hole in it.
 *
 * The guards that make that claim survivable are the ones a customer link does not have: SINGLE
 * USE, a short expiry, a short SESSION (24 hours, not 90 days), and an operator kill switch on
 * every live link for a rep whose address changes.
 *
 * ── AND IT DOES NOT SPEND THE CUSTOMER'S RATE LIMIT ─────────────────────────────────────────────
 * Its own key, repauth:ip:. Sharing `magic:ip:` would mean a rep signing in repeatedly could lock a
 * customer out of their own invoice, and a busy garage could lock a rep out of their commission.
 * Measured on 2026-09-09: the gate suite alone put SIXTY hits on magic:ip:::1 in forty minutes and
 * exhausted it, which is what a shared key looks like from the inside.
 */
import type { PrismaClient, Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import { hashToken } from '@/lib/tokens';
import { newMagicToken } from '@/lib/magic-link';
import { takeToken } from '@/lib/auth-rate-limit';

type Db = PrismaClient | Prisma.TransactionClient;

// Defined in lib/rep-link-copy, which imports NOTHING — see that file for the sign-in page this
// move fixes. Re-exported so server-side callers here keep one import.
export { REP_LINK_MINUTES, repSpendMessage, type RepSpendReason } from '@/lib/rep-link-copy';
import { REP_LINK_MINUTES } from '@/lib/rep-link-copy';

/**
 * HOW LONG THE SESSION LIVES. Twenty-four hours, against the platform's ninety days.
 *
 * The 90-day rolling session is a deliberate ruling (2026-07-12) made for the mechanic PWA, where a
 * phone in a workshop opens the app once a month. It is the wrong number here for a reason specific
 * to this actor: a rep signs in on a forecourt, often on a borrowed or shared handset, and what is
 * on their screen is other people's commission and their own bank details. Enforced in the jwt
 * callback against our own authAt stamp, for actorClass 'rep' only — every other class keeps 90 days.
 */
export const REP_SESSION_HOURS = 24;

/**
 * WHY A LINK WAS KILLED. A closed set, mirroring the commission codes: prose that could name a
 * person belongs in a note, not in a column somebody filters on.
 * RepMagicLink_revoked_reason_chk holds this exact set.
 */
export const REP_REVOKE_REASONS = ['wrong_address', 'email_changed', 'rep_suspended', 'superseded'] as const;
export type RepRevokeReason = (typeof REP_REVOKE_REASONS)[number];

/** Its OWN limiter key — see the header. Per-IP is the real axis; the token is already a secret. */
export const REP_LIMITS = { perIp: { max: 30, windowMinutes: 60 } };

/**
 * IS THIS REP SESSION PAST ITS WINDOW? The rule, as a pure function, so it can be proved without a
 * clock and without standing up NextAuth. The jwt callback asks THIS rather than re-deriving the
 * comparison, for the usual reason: a second copy is a second thing to be right about.
 *
 * FAILS CLOSED. An absent or non-numeric authAt is EXPIRED, not fresh — a token minted before this
 * floor existed carries no stamp, and treating a missing stamp as a recent sign-in would exempt
 * precisely the sessions that predate the rule.
 */
export function repSessionExpired(authAt: unknown, now: number = Date.now()): boolean {
  if (typeof authAt !== 'number' || !authAt) return true;
  return now - authAt > REP_SESSION_HOURS * 3600_000;
}

export type MintedRepLink = { id: string; rawToken: string; url: string; expiresAt: Date };

/**
 * SUPERSEDES EVERY LIVE LINK FOR THIS REP. Two live credentials in one inbox is two chances to
 * forward the wrong one, and the second request is the rep telling us the first did not arrive.
 */
export async function mintRepLink(args: {
  repId: string;
  sentTo: string;
  baseUrl: string;
  db?: Db;
}): Promise<MintedRepLink> {
  const db = (args.db ?? prisma) as PrismaClient;
  await db.repMagicLink.updateMany({
    where: { rep_id: args.repId, consumed_at: null, revoked_at: null },
    data: { revoked_at: new Date(), revoked_reason: 'superseded' },
  });
  const raw = newMagicToken();
  const expiresAt = new Date(Date.now() + REP_LINK_MINUTES * 60_000);
  const row = await db.repMagicLink.create({
    data: {
      rep_id: args.repId,
      purpose: 'sign_in',
      token_hash: hashToken(raw),
      sent_to: args.sentTo,
      expires_at: expiresAt,
    },
    select: { id: true },
  });
  return { id: row.id, rawToken: raw, url: repLinkUrl(raw, args.baseUrl), expiresAt };
}

export function repLinkUrl(rawToken: string, baseUrl: string): string {
  return `${baseUrl.replace(/\/$/, '')}/rep/enter/${rawToken}`;
}

export type RepSpend =
  | { ok: true; repId: string }
  | { ok: false; reason: 'not_found' | 'expired' | 'revoked' | 'consumed' | 'rate_limited' | 'suspended' };

/**
 * ── SPEND IT. THE CLAIM IS THE UPDATE, AND THERE IS NO READ BEFORE IT. ──────────────────────────
 * A read-then-write leaves a window between deciding the token is unspent and marking it spent, and
 * two replays of the same URL — an email client prefetching while the rep clicks, say — both fall
 * inside it. Here the WHERE clause carries the whole decision: Postgres takes the row lock, the
 * loser blocks, re-evaluates after the winner commits, finds consumed_at set and matches nothing.
 * Affected-row count 1 is the only success.
 *
 * This is the shape lib/rep-pay-run::releaseEntry uses for money, and deliberately NOT a unique
 * index with a caught error — see the named fact at the top of schema.prisma for why a catch is
 * itself the failure.
 */
export async function spendRepLink(rawToken: string, opts: { ip: string; db?: Db }): Promise<RepSpend> {
  const db = (opts.db ?? prisma) as PrismaClient;
  const allowed = await takeToken(`repauth:ip:${opts.ip}`, REP_LIMITS.perIp.max, REP_LIMITS.perIp.windowMinutes);
  if (!allowed) return { ok: false, reason: 'rate_limited' };

  const hash = hashToken(rawToken);
  const claimed = await db.repMagicLink.updateMany({
    where: { token_hash: hash, consumed_at: null, revoked_at: null, expires_at: { gt: new Date() } },
    data: { consumed_at: new Date() },
  });

  if (claimed.count === 1) {
    const row = await db.repMagicLink.findFirst({ where: { token_hash: hash }, select: { rep_id: true } });
    const rep = await db.rep.findUnique({ where: { id: row!.rep_id }, select: { id: true, status: true } });
    // SUSPENDED IS CHECKED AFTER THE BURN, ON PURPOSE. The token is spent either way: a link that
    // failed for a reason on our side must not remain usable if the suspension is lifted, because
    // whoever tried it has now proved they hold it.
    if (!rep || rep.status !== 'active') return { ok: false, reason: 'suspended' };
    return { ok: true, repId: rep.id };
  }

  // AFTER THE FACT. Nothing below decides anything — the row is already claimed or already lost.
  // This exists only so the page can say which of four things happened instead of "invalid link",
  // which sends somebody to support for a link they simply used twice.
  const row = await db.repMagicLink.findFirst({
    where: { token_hash: hash },
    select: { consumed_at: true, revoked_at: true, expires_at: true },
  });
  if (!row) return { ok: false, reason: 'not_found' };
  if (row.revoked_at) return { ok: false, reason: 'revoked' };
  if (row.consumed_at) return { ok: false, reason: 'consumed' };
  return { ok: false, reason: 'expired' };
}

/** The operator kill switch. Every live link for one rep, in one statement. */
export async function revokeRepLinks(repId: string, reason: RepRevokeReason, db: Db = prisma): Promise<number> {
  const r = await (db as PrismaClient).repMagicLink.updateMany({
    where: { rep_id: repId, consumed_at: null, revoked_at: null },
    data: { revoked_at: new Date(), revoked_reason: reason },
  });
  return r.count;
}
