/**
 * File: lib/affiliate-admin.ts
 * THE ENGINE ROOM'S READ MODEL FOR AFFILIATES, and the one writer behind suspend/unsuspend.
 *
 * Separate from lib/affiliate — which owns the RULES about money — because this owns a QUESTION:
 * what does an operator need on one screen to decide whether to suspend somebody. Nothing here
 * computes a reward; it reads what the rules already wrote.
 *
 * ── EVERY FIELD IS DERIVED, AND NONE OF THEM IS A SECOND SOURCE OF TRUTH ───────────────────────
 * The verified mobile comes from TwoFactorSecret (where confirmPhoneVerification writes it), the
 * verified email from Rep.email_verified_at (where the link stamps it), the garages from
 * TenantAffiliateTerms (frozen at signup) joined to their Group status, and the money from
 * CommissionEntry. There is no affiliate_summary table and there must not be: every number on the
 * screen is a read of the row that decided it.
 */
import { prisma as defaultDb } from '@/lib/db';
import { AFFILIATE_HOLD_DAYS, rewardIsPayable } from '@/lib/affiliate';

type Db = any; // a PrismaClient or an interactive-transaction client

/** A garage this affiliate introduced, named only as much as an operator needs. */
export type ReferredGarage = {
  groupId: string;
  ref: string | null;
  name: string;
  /** Group.status — 'trial', 'ok', 'suspended', … whatever the tenant lifecycle says today. */
  status: string;
  referredAt: Date;
  /** Has this garage ever paid us? The honest basis for "is this referral worth anything". */
  everPaid: boolean;
};

export type AffiliateRow = {
  id: string;
  name: string;
  email: string;
  refCode: string;
  joinedAt: Date;
  /** The number they proved, in dialable form, or null if they never did. */
  mobile: string | null;
  mobileVerifiedAt: Date | null;
  emailVerifiedAt: Date | null;
  termsAcceptedAt: Date | null;
  suspendedAt: Date | null;
  socialHandle: string | null;
  garages: ReferredGarage[];
  /** Accruals minus clawbacks, in pennies — what the ledger says they have earned, net. */
  earnedPennies: number;
  /**
   * How much of that has matured past the hold. THE FIRST READER of rewardIsPayable, which shipped
   * in slice A with nothing consulting it — recorded here because a rule nobody reads is a rule
   * nobody can see is wrong.
   */
  payablePennies: number;
  heldPennies: number;
};

/**
 * EVERY AFFILIATE, with what the screen needs. One query per table rather than one per affiliate:
 * the list is tens of rows today and a per-row lookup would be a hundred round trips the moment it
 * is hundreds.
 */
export async function listAffiliates(db: Db = defaultDb, now: Date = new Date()): Promise<AffiliateRow[]> {
  const reps = await db.rep.findMany({
    where: { party_type: 'affiliate' },
    orderBy: { created_at: 'desc' },
    select: {
      id: true, name: true, email: true, ref_code: true, created_at: true,
      email_verified_at: true, terms_accepted_at: true, suspended_at: true, social_handle: true,
    },
  });
  if (reps.length === 0) return [];
  const ids = reps.map((r: any) => r.id);

  const phones = await db.twoFactorSecret.findMany({
    where: { subject_type: 'rep', subject_id: { in: ids } },
    select: { subject_id: true, phone_e164: true, phone_verified_at: true },
  });
  const terms = await db.tenantAffiliateTerms.findMany({
    where: { affiliate_id: { in: ids } },
    // signed_up_at, NOT created_at: the row is dated by WHEN THE GARAGE SIGNED UP, which is the
    // fact an operator is reading. created_at is when we wrote the row and would differ on a backfill.
    select: { affiliate_id: true, group_id: true, signed_up_at: true },
  });
  const groupIds = terms.map((t: any) => t.group_id);
  const groups = groupIds.length
    ? await db.group.findMany({
      where: { id: { in: groupIds } },
      select: { id: true, ref: true, group_name: true, status: true, billing: { select: { first_paid_at: true } } },
    })
    : [];
  // THE LEDGER, with the dates: a sum alone cannot say what has matured, and the hold is derived
  // from the invoice's paid date rather than stored (see AFFILIATE_HOLD_DAYS).
  const entries = await db.commissionEntry.findMany({
    where: { party_type: 'affiliate', party_id: { in: ids } },
    select: { party_id: true, amount_pennies: true, kind: true, created_at: true },
  });

  const phoneBy = new Map(phones.map((p: any) => [p.subject_id, p]));
  const groupBy = new Map(groups.map((g: any) => [g.id, g]));

  return reps.map((r: any) => {
    const mine = terms.filter((t: any) => t.affiliate_id === r.id);
    const garages: ReferredGarage[] = mine.map((t: any) => {
      const g = groupBy.get(t.group_id) as any;
      return {
        groupId: t.group_id,
        ref: g?.ref ?? null,
        // A GARAGE WITH NO NAME YET IS NORMAL: the signup writes a neutral placeholder and the
        // onboarding step asks for the real one. Saying so beats printing an empty cell.
        name: g?.group_name ?? '(unknown garage)',
        status: g?.status ?? 'unknown',
        referredAt: t.signed_up_at,
        everPaid: !!g?.billing?.first_paid_at,
      };
    });
    const ledger = entries.filter((e: any) => e.party_id === r.id);
    const earnedPennies = ledger.reduce((n: number, e: any) => n + e.amount_pennies, 0);
    // PAYABLE IS ABOUT THE ACCRUALS' OWN DATES. A clawback is netted off the total but does not
    // have a hold of its own to mature past — it is money going back, not money becoming sendable.
    const payablePennies = ledger
      .filter((e: any) => e.kind === 'accrual' && rewardIsPayable({ paidAt: e.created_at, now }))
      .reduce((n: number, e: any) => n + e.amount_pennies, 0)
      + ledger.filter((e: any) => e.kind === 'clawback').reduce((n: number, e: any) => n + e.amount_pennies, 0);
    const phone = phoneBy.get(r.id) as any;
    return {
      id: r.id,
      name: r.name,
      email: r.email,
      refCode: r.ref_code,
      joinedAt: r.created_at,
      mobile: phone?.phone_e164 ?? null,
      mobileVerifiedAt: phone?.phone_verified_at ?? null,
      emailVerifiedAt: r.email_verified_at,
      termsAcceptedAt: r.terms_accepted_at,
      suspendedAt: r.suspended_at,
      socialHandle: r.social_handle,
      garages,
      earnedPennies,
      // NEVER BELOW ZERO ON THE SCREEN: a net-negative payable is a clawback waiting for the next
      // accrual, which is what the ledger means, and "-£30 payable" reads as a demand for money.
      payablePennies: Math.max(0, payablePennies),
      heldPennies: Math.max(0, earnedPennies - Math.max(0, payablePennies)),
    };
  });
}

export const HOLD_DAYS = AFFILIATE_HOLD_DAYS;

export type SuspendResult =
  | { ok: true; suspendedAt: Date | null }
  | { ok: false; message: string };

/**
 * SUSPEND OR UNSUSPEND, and this is the only writer of Rep.suspended_at for an affiliate.
 *
 * WHAT SUSPENSION MEANS, in one place because three different paths read it:
 *   • no NEW referral is attributed  — lib/attribution answers `suspended` for the code;
 *   • no NEW garage gets the offer    — the same answer feeds refuseOffer;
 *   • nothing earns FROM THAT MOMENT  — lib/affiliate::refuseSuspended, a date comparison.
 * What it does NOT mean: a garage already referred keeps its frozen terms and its price, and
 * nothing already accrued is reversed. Only a refund does that.
 *
 * IDEMPOTENT, and it says so rather than throwing: suspending a suspended affiliate is what a
 * second click on a slow screen does, and the DATE must not move — "from that moment" would
 * otherwise mean "from the last time anybody clicked".
 */
export async function setSuspended(
  db: Db,
  args: { affiliateId: string; suspended: boolean; at?: Date },
): Promise<SuspendResult> {
  const rep = await db.rep.findUnique({
    where: { id: args.affiliateId },
    select: { id: true, party_type: true, suspended_at: true },
  });
  if (!rep) return { ok: false, message: 'No such affiliate.' };
  // A RESELLER IS NOT SUSPENDED FROM HERE. Their arrangement has its own screen and its own
  // consequences; one endpoint quietly governing both would make this button mean two things.
  if (rep.party_type !== 'affiliate') return { ok: false, message: 'That party is a reseller, not an affiliate. Use the reseller screen.' };

  if (args.suspended && rep.suspended_at) return { ok: true, suspendedAt: rep.suspended_at };
  if (!args.suspended && !rep.suspended_at) return { ok: true, suspendedAt: null };

  const suspendedAt = args.suspended ? (args.at ?? new Date()) : null;
  await db.rep.update({ where: { id: rep.id }, data: { suspended_at: suspendedAt } });
  return { ok: true, suspendedAt };
}
