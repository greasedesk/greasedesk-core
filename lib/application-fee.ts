/**
 * File: lib/application-fee.ts
 * THE application-fee chokepoint: which rate applies to a payment, and what it comes to.
 *
 * Deliberately shaped like lib/commission — effective-dated rows, latest boundary at or before the
 * moment, and a REFUSAL rather than a default when nothing matches. A missing rate must never
 * quietly become a zero fee: a silent zero is indistinguishable from a working integration that
 * happens to earn nothing, and it would be discovered in a revenue report months later.
 *
 * ── THE FEE IS FLOORED, NOT ROUNDED ─────────────────────────────────────────────────────────────
 * fee = floor(amount × bp / 10000). lib/commission::splitAmount floors and then redistributes the
 * remainder because it must preserve a total across parties; there is no total to preserve here, so
 * the remainder is simply dropped. Dropping it means we never round our own cut UP — a £50 MOT is
 * 12p and not 13p. That is worth a fraction of a penny per transaction and it is a sentence we can
 * say out loud.
 *
 * ── VAT, SETTLED 2026-08-15 ─────────────────────────────────────────────────────────────────────
 * The fee is a SEPARATE TAXABLE SUPPLY by GreaseDesk to the garage, standard-rated at 20% once we
 * are registered. It is EXCLUSIVE: 0.25% plus VAT where applicable. So 25 basis points is the
 * right number and does NOT become 30.
 *
 * THIS DEPARTS FROM THE SUBSCRIPTION ON PURPOSE. The £75 is quoted INCLUDING VAT (see lib/stripe
 * and Terms §5) and this is exclusive. The reasoning is different, not inconsistent: a round number
 * matters when a garage owner is choosing software and comparing prices, and does not matter at all
 * when a fee is a line on a statement they reconcile monthly. Both were chosen; neither is drift.
 *
 * WHAT OUR TURNOVER IS. The fee, and only the fee. A customer's payment to a garage is never our
 * turnover — it belongs to the garage, lands in the garage's own Stripe account, and passes through
 * no account of ours. That is precisely what makes taking a percentage viable: 0.25% of £74,399 is
 * £186 of turnover, not £74,399. The Standard-account choice (lib/stripe-connect) is what keeps
 * that true in fact, and the Terms payments clause is what keeps it true on paper.
 *
 * NOT BUILT: once we are registered, a garage reclaiming input VAT needs a VAT invoice from us for
 * the fees they have paid — a monthly consolidated invoice on its own sequential series, carrying
 * our VAT number and their details, net and VAT split, reconciling against Stripe's deductions.
 * Banked, and not needed until registration.
 */
import type { PrismaClient, Prisma } from '@prisma/client';

type Db = PrismaClient | Prisma.TransactionClient;

export type FeeRate = {
  id: string;
  group_id: string | null;
  basis_points: number;
  min_fee_pennies: number | null;
  cap_fee_pennies: number | null;
};

/**
 * What the fee comes to. Pure, so the gate asserts the real rule rather than a copy of it.
 *
 * The floor and cap are applied AFTER the percentage and in that order; both are null today, so
 * today this is just the floored percentage. A negative or zero amount yields nothing — there is no
 * such thing as a fee on money that did not move, and a refund is a Refund row, never a negative
 * payment.
 */
export function applicationFeePennies(amountPennies: number, rate: Pick<FeeRate, 'basis_points' | 'min_fee_pennies' | 'cap_fee_pennies'>): number {
  if (!Number.isFinite(amountPennies) || amountPennies <= 0) return 0;
  let fee = Math.floor((amountPennies * rate.basis_points) / 10000);
  if (rate.min_fee_pennies != null) fee = Math.max(fee, rate.min_fee_pennies);
  if (rate.cap_fee_pennies != null) fee = Math.min(fee, rate.cap_fee_pennies);
  // A fee can never exceed the payment it is taken from — Stripe would reject the charge, and the
  // arithmetic that produced it would be wrong anyway. Belt and braces against a mis-keyed cap.
  return Math.min(fee, amountPennies);
}

/**
 * THE rate for a payment. Most-specific-first, then most-recent-within-that-scope.
 *
 * ── A TENANT ROW BEATS A PLATFORM ROW REGARDLESS OF DATES ───────────────────────────────────────
 * This is the part worth reading twice. If a garage has a negotiated rate effective from January
 * and we change the platform default in June, the garage keeps its January rate. The plausible
 * misreading — newest effective_from wins across both scopes — would silently reprice every
 * negotiated tenant the next time we touched the default, which is exactly the kind of change
 * nobody would notice until a garage did.
 *
 * Two queries rather than one clever ordering: `ORDER BY group_id DESC NULLS LAST` expresses the
 * same thing and is one subtlety away from being wrong the day somebody "simplifies" it.
 *
 * THROWS when nothing matches. Same discipline as lib/commission's resolveRate — refusing to invent
 * one — because the alternative is charging a garage nothing and calling it a working integration.
 */
export async function resolveFeeRate(
  db: Db,
  args: { groupId: string; country: string; currency: string; at: Date },
): Promise<FeeRate> {
  const select = { id: true, group_id: true, basis_points: true, min_fee_pennies: true, cap_fee_pennies: true } as const;
  const common = {
    country_code: args.country,
    currency: args.currency,
    effective_from: { lte: args.at },
  };

  const tenant = (await (db as any).applicationFeeRate.findFirst({
    where: { group_id: args.groupId, ...common },
    orderBy: { effective_from: 'desc' },
    select,
  })) as FeeRate | null;
  if (tenant) return tenant;

  const platform = (await (db as any).applicationFeeRate.findFirst({
    where: { group_id: null, ...common },
    orderBy: { effective_from: 'desc' },
    select,
  })) as FeeRate | null;
  if (platform) return platform;

  throw new Error(
    `APPFEE: no application fee rate for ${args.country}/${args.currency} at ${args.at.toISOString()} — refusing to invent one`,
  );
}

/** Resolve and compute in one step, for the PaymentIntent path. Returns the frozen rate id with it. */
export async function feeForPayment(
  db: Db,
  args: { groupId: string; country: string; currency: string; at: Date; amountPennies: number },
): Promise<{ feePennies: number; rateId: string }> {
  const rate = await resolveFeeRate(db, args);
  return { feePennies: applicationFeePennies(args.amountPennies, rate), rateId: rate.id };
}
