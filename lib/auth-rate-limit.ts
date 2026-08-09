/**
 * File: lib/auth-rate-limit.ts
 * Shared-state rate limiting for UNAUTHENTICATED auth endpoints (forgot-password).
 *
 * WHY DB-BACKED: serverless has no usable in-memory state — invocations are cold and concurrent, so
 * a module-level Map limits nothing. There is no Redis/KV in this stack, and adding one for a single
 * low-traffic endpoint is new infra, env and cost. The Postgres every request already touches IS the
 * shared store. Append-only rows, counted over a sliding window, pruned opportunistically.
 *
 * PRIVACY: the email axis is keyed by SHA-256, never the address — this table must never become a
 * plaintext list of who asked for a reset.
 */
import { prisma } from '@/lib/db';
import { hashToken } from '@/lib/tokens';

export const LIMITS = {
  perEmail: { max: 3, windowMinutes: 60 },
  perIp: { max: 10, windowMinutes: 60 },
};

export const emailKey = (email: string) => `email:${hashToken(email.trim().toLowerCase())}`;
export const ipKey = (ip: string) => `ip:${ip}`;

/** True when the key is still UNDER its limit (and records the attempt). Never throws — a limiter
 *  failure must not take the endpoint down, so on error we allow (availability > perfect limiting). */
export async function takeToken(key: string, max: number, windowMinutes: number): Promise<boolean> {
  const since = new Date(Date.now() - windowMinutes * 60 * 1000);
  try {
    const used = await prisma.authRateLimit.count({ where: { key, created_at: { gte: since } } });
    if (used >= max) return false;
    await prisma.authRateLimit.create({ data: { key } });
    // Opportunistic prune of this key's expired rows — keeps the table from growing unbounded
    // without needing a cron. Best-effort.
    prisma.authRateLimit.deleteMany({ where: { key, created_at: { lt: since } } }).catch(() => {});
    return true;
  } catch {
    return true;
  }
}

/**
 * ── THE FAIL-CLOSED VARIANT (ruling 2026-08-08) ─────────────────────────────────────────────────
 * takeToken above ALLOWS on error, and that is right for what it guards: a limiter outage must not
 * lock everyone out of password reset, and the magic-link token is 96 bits so the limiter is
 * belt-and-braces there anyway.
 *
 * It is WRONG the moment a call costs money. An SMS send that fails open turns a database blip into
 * unmetered spend, and the attacker picks the moment. So the send axis refuses when it cannot
 * establish that the caller is under the limit — "we couldn't check, so we didn't spend" is a
 * recoverable answer; an unbounded bill is not.
 *
 * Note the asymmetry inside one feature and keep it: SENDING a code fails closed, CHECKING one
 * keeps failing open, because a user who cannot verify is stranded and verification costs nothing.
 */
export async function takeTokenStrict(key: string, max: number, windowMinutes: number): Promise<boolean> {
  const since = new Date(Date.now() - windowMinutes * 60 * 1000);
  try {
    const used = await prisma.authRateLimit.count({ where: { key, created_at: { gte: since } } });
    if (used >= max) return false;
    await prisma.authRateLimit.create({ data: { key } });
    prisma.authRateLimit.deleteMany({ where: { key, created_at: { lt: since } } }).catch(() => {});
    return true;
  } catch {
    return false; // could not establish that we are under the limit → do not spend
  }
}

/**
 * THE SMS SEND BUDGET, in one place so no caller invents its own. Five axes, each answering a
 * different abuse:
 *   perSubject     — the tightest and most useful: one account cannot be milked for codes
 *   perDestination — one handset, many accounts (the enumeration/harassment shape)
 *   perIp          — the ONLY axis available before anyone is authenticated
 *   perTenant      — blast radius: one compromised account cannot spend the garage's whole budget
 * plus the resend cooldown, which lives with the code itself (lib/delivered-code) because it is a
 * property of the code, not of the caller.
 */
export const SMS_LIMITS = {
  perSubject: { max: 5, windowMinutes: 60 },
  perDestination: { max: 5, windowMinutes: 60 },
  perIp: { max: 10, windowMinutes: 60 },
  perTenant: { max: 100, windowMinutes: 60 * 24 },
};

export const smsSubjectKey = (t: string, id: string) => `sms:sub:${t}:${id}`;
/** HASHED, like the email axis: this table must never become a plaintext list of phone numbers. */
export const smsDestinationKey = (e164: string) => `sms:dst:${hashToken(e164)}`;
export const smsIpKey = (ip: string) => `sms:ip:${ip}`;
export const smsTenantKey = (groupId: string) => `sms:grp:${groupId}`;

/**
 * ── RETENTION, AND WHY THE OPPORTUNISTIC PRUNE IS NOT ENOUGH ────────────────────────────────────
 * takeToken prunes expired rows FOR THE KEY IT IS TAKING. That only ever reaches keys that come
 * back: a key used once and never again is never pruned by anything. Two shapes guarantee that —
 *   • a deleted tenant's `sms:grp:<id>`, which cannot recur by definition;
 *   • a one-off IP, which usually doesn't.
 * The table was found holding rows three weeks old, five of them naming a raw IP address, four
 * naming a tenant that had been purged. So retention is now TIME-based and unconditional.
 *
 * Derived from the windows rather than typed as a number: a row older than the longest window can
 * no longer affect any limit decision, and doubling it leaves generous headroom for clock skew and
 * a late cron. Add a longer window above and the retention follows it automatically.
 *
 * NOTE on the header's privacy claim: the email and destination axes are hashed, but ipKey and
 * smsIpKey store the address in clear — there is no way to rate-limit by IP without holding it.
 * This reaper is what bounds how long we hold it.
 */
export const RATE_LIMIT_RETENTION_MINUTES =
  2 * Math.max(
    ...Object.values(LIMITS).map((l) => l.windowMinutes),
    ...Object.values(SMS_LIMITS).map((l) => l.windowMinutes),
  );

/**
 * Delete every rate-limit row older than the retention window, whatever its key. Returns the count.
 * Unconditional by design: it must not depend on a key recurring, because that is the flaw it fixes.
 */
export async function reapRateLimits(now: Date = new Date()): Promise<{ deleted: number; cutoff: Date }> {
  const cutoff = new Date(now.getTime() - RATE_LIMIT_RETENTION_MINUTES * 60 * 1000);
  const r = await prisma.authRateLimit.deleteMany({ where: { created_at: { lt: cutoff } } });
  return { deleted: r.count, cutoff };
}

/** Rate-limit keys belonging to one tenant and its users — what a purge must take with it. */
export function tenantRateLimitKeys(groupId: string, userIds: string[]): string[] {
  return [smsTenantKey(groupId), ...userIds.map((id) => smsSubjectKey('tenant', id))];
}

/** Best-effort client IP for the per-IP axis. */
export function clientIp(headers: Record<string, string | string[] | undefined>): string {
  const xff = headers['x-forwarded-for'];
  const raw = Array.isArray(xff) ? xff[0] : xff;
  return (raw ? raw.split(',')[0].trim() : '') || 'unknown';
}

/** Pad a handler to a fixed floor so "address exists" and "doesn't exist" take comparable time.
 *  The real leak is that only the exists-branch awaits a Resend call; this flattens it. */
export async function constantTime<T>(startedAt: number, floorMs: number, value: T): Promise<T> {
  const elapsed = Date.now() - startedAt;
  if (elapsed < floorMs) await new Promise((r) => setTimeout(r, floorMs - elapsed));
  return value;
}
