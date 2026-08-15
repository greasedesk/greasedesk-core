/**
 * File: lib/sms-allowance.ts
 * THE SMS allowance: 100 messages a month in the £75, top-ups in hundreds, and one place that says
 * how many are left.
 *
 * ── DERIVED, NEVER STORED ───────────────────────────────────────────────────────────────────────
 * There is no `remaining` column. Usage is already recorded — every accepted send is a
 * NotificationLog row — and purchases are SmsTopUp rows, so the balance is arithmetic over two
 * things that exist for other reasons. The same rule that made Invoice.amount_paid_pennies a cache
 * of the Payment ledger: a decrement-on-send counter is a second opinion, and it drifts the first
 * time a send half-fails.
 *
 * ── A CALENDAR MONTH, NOT THE BILLING PERIOD ────────────────────────────────────────────────────
 * Deliberately NOT GroupBilling.current_period_end, and the schema already records why: Stripe
 * ADVANCES that date on a failed-payment retry, which is the exact reason lib/billing's grace
 * countdown anchors elsewhere. An allowance keyed to it would silently reset every time a card
 * bounced — the worst possible month to hand someone free messages. A calendar month is also what
 * a garage means by "a hundred a month", and it needs no explanation.
 *
 * ── WHAT COUNTS ─────────────────────────────────────────────────────────────────────────────────
 * A send the PROVIDER ACCEPTED, which is exactly the rows carrying a provider_message_id. A message
 * refused before it left — opted out, no recipient, provider not configured — cost nothing and must
 * not be billed as one. A message Twilio accepted and later failed to deliver DID cost, and counts:
 * we are passing on what we are charged for, not what arrived.
 *
 * SECURITY MESSAGES ARE OUTSIDE THE ALLOWANCE ENTIRELY — neither counted nor refused. A phone
 * verification code is OUR account security, not the garage's customer messaging, and locking a
 * garage owner out of their own account because they had sent a hundred quotes would be indefensible.
 * The same asymmetry lib/notification-templates already draws with `security: true`.
 */
import type { PrismaClient, Prisma } from '@prisma/client';

type Db = PrismaClient | Prisma.TransactionClient;

/** Included in the subscription, per calendar month. Resets; does not roll over. */
export const SMS_INCLUDED_PER_MONTH = 100;
/** Top-ups are sold in hundreds. One place, so the Engine Room and the buy button cannot disagree. */
export const SMS_TOPUP_PACK = 100;

export type SmsAllowance = {
  /** The monthly grant. */
  included: number;
  /** Accepted sends inside the current calendar month. */
  usedThisMonth: number;
  /** Of the monthly grant, how much is left. Never negative. */
  includedRemaining: number;
  /** Purchased messages still unspent, carried across months. */
  topUpRemaining: number;
  /** What a garage should be shown: the two added together. */
  remaining: number;
  /** Total ever bought, for the Engine Room. */
  purchased: number;
  /** When the monthly grant next resets — first instant of next month, UTC. */
  resetsAt: Date;
};

/** First instant of the UTC month containing `d`. Month boundaries are UTC so they do not move. */
export const monthStart = (d: Date): Date => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
export const monthEnd = (d: Date): Date => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1));
/** 'YYYY-MM' — the grouping key. */
export const monthKey = (d: Date): string => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;

/**
 * THE ARITHMETIC, pure so the gate asserts the real rule.
 *
 * Each month spends its own hundred first; anything beyond that in a month is OVERFLOW and comes
 * out of purchased packs. Summing overflow across every month is what makes top-ups roll over
 * without a stored balance: a pack bought in March is still there in June if March never needed it.
 *
 * `usageByMonth` is every month that has any usage, as { 'YYYY-MM': count }.
 */
export function computeAllowance(args: {
  usageByMonth: Record<string, number>;
  purchased: number;
  now: Date;
}): SmsAllowance {
  const key = monthKey(args.now);
  const usedThisMonth = args.usageByMonth[key] ?? 0;

  // Every month pays its own way first. What a month could not cover came out of packs — INCLUDING
  // the current month, which is why this sums over all of them rather than only the closed ones.
  let overflowAllTime = 0;
  for (const n of Object.values(args.usageByMonth)) {
    overflowAllTime += Math.max(0, n - SMS_INCLUDED_PER_MONTH);
  }

  const includedRemaining = Math.max(0, SMS_INCLUDED_PER_MONTH - usedThisMonth);
  // Never negative: a pack cannot be over-spent, because the refusal stops the send that would.
  // If it ever goes negative anyway that is a real defect, and clamping here would hide it — so the
  // gate asserts the unclamped figure separately.
  const topUpRemaining = Math.max(0, args.purchased - overflowAllTime);

  return {
    included: SMS_INCLUDED_PER_MONTH,
    usedThisMonth,
    includedRemaining,
    topUpRemaining,
    remaining: includedRemaining + topUpRemaining,
    purchased: args.purchased,
    resetsAt: monthEnd(args.now),
  };
}

/**
 * Read the tenant's allowance. Two queries and no writes, so it is safe to call on a page render.
 *
 * The usage query counts rows the PROVIDER ACCEPTED — `provider_message_id` is not null — which is
 * the honest test for "did this cost us anything". Grouping in SQL rather than pulling rows keeps
 * this cheap for a tenant with years of history.
 */
export async function smsAllowance(db: Db, groupId: string, now: Date = new Date()): Promise<SmsAllowance> {
  const [rows, agg] = await Promise.all([
    (db as any).$queryRawUnsafe(
      `SELECT to_char(date_trunc('month', created_at AT TIME ZONE 'UTC'), 'YYYY-MM') AS m, COUNT(*)::int AS n
         FROM "NotificationLog"
        WHERE group_id = $1
          AND channel = 'sms'::"NotificationChannel"
          AND direction = 'out'
          AND provider_message_id IS NOT NULL
          AND counts_to_allowance = true
        GROUP BY 1`,
      groupId,
    ) as Promise<Array<{ m: string; n: number }>>,
    (db as any).smsTopUp.aggregate({ where: { group_id: groupId }, _sum: { quantity: true } }),
  ]);

  const usageByMonth: Record<string, number> = {};
  for (const r of rows) usageByMonth[r.m] = r.n;
  return computeAllowance({ usageByMonth, purchased: agg?._sum?.quantity ?? 0, now });
}
