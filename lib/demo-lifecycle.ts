/**
 * File: lib/demo-lifecycle.ts
 * WHEN a demo warns, when it emails, and when it dies — one rule, read by all three.
 *
 * The banner, the reminder email and the purge are three surfaces answering the same question, and
 * a demo that warns on Tuesday, emails on Thursday and dies on Wednesday would be worse than one
 * that just vanished. So the phase is computed here and nowhere else.
 *
 * ── A NULL EXPIRY IS IMMORTAL, AND THAT IS THE SAFE FAILURE ─────────────────────────────────────
 * The long-lived sales demo has no expiry. Every function here returns `none` for a null, and the
 * cron's predicate requires a non-null date IN THE PAST — so the worst a missing expiry can do is
 * leave a tenant alive, which is visible in the Engine Room. The opposite mistake deletes a garage.
 *
 * ── DAYS ARE COUNTED IN WHOLE DAYS, CEILINGED ───────────────────────────────────────────────────
 * `daysLeft` is what a person is told, so 0.3 of a day left is "1 day", not "0 days" and not
 * "today". Ceiling means the banner never says zero while the tenant is still usable.
 */

export type DemoPhase =
  /** Not a demo, or no expiry set (the sales demo). Nothing to say and nothing to do. */
  | 'none'
  /** Alive and not worth mentioning yet. */
  | 'live'
  /** Close enough to say so in the app. */
  | 'warning'
  /** Last day — the email goes now if it has not already. */
  | 'final'
  /** Past its expiry. The cron purges it. */
  | 'expired';

/** Banner from this many whole days out, inclusive. Day 5 of a 7-day demo. */
export const DEMO_WARN_DAYS = 2;
/** Email at this many whole days out. Day 6 of a 7-day demo. */
export const DEMO_EMAIL_DAYS = 1;
/** The template the reminder goes out on — also the idempotency key against NotificationLog. */
export const DEMO_EXPIRY_TEMPLATE = 'demo_expiring';

export type DemoLifecycle = {
  phase: DemoPhase;
  /** Whole days remaining, ceilinged, or null when there is no expiry. */
  daysLeft: number | null;
  expiresAt: Date | null;
};

export function demoLifecycle(
  group: { is_demo?: boolean | null; demo_expires_at?: Date | string | null } | null | undefined,
  now: Date = new Date(),
): DemoLifecycle {
  if (!group?.is_demo || !group.demo_expires_at) return { phase: 'none', daysLeft: null, expiresAt: null };
  const expiresAt = new Date(group.demo_expires_at);
  if (Number.isNaN(expiresAt.getTime())) return { phase: 'none', daysLeft: null, expiresAt: null };

  const msLeft = expiresAt.getTime() - now.getTime();
  if (msLeft <= 0) return { phase: 'expired', daysLeft: 0, expiresAt };

  const daysLeft = Math.ceil(msLeft / 86_400_000);
  const phase: DemoPhase = daysLeft <= DEMO_EMAIL_DAYS ? 'final'
    : daysLeft <= DEMO_WARN_DAYS ? 'warning'
      : 'live';
  return { phase, daysLeft, expiresAt };
}

/** The cron's own predicate, stated once. NON-NULL and IN THE PAST — never one or the other. */
export const isPurgeable = (
  group: { is_demo?: boolean | null; demo_expires_at?: Date | string | null },
  now: Date = new Date(),
): boolean => demoLifecycle(group, now).phase === 'expired';

/**
 * The link the reminder email carries. Without it a purged user signs in, gets the generic
 * "Invalid email or password" — the same message a typo produces — and concludes they have
 * forgotten their password rather than that the demo ended. One query parameter is the whole
 * difference between a clean ending and a confusing one.
 */
export const demoExpiredLoginUrl = (base: string): string => `${base.replace(/\/$/, '')}/admin/login?demo=expired`;
