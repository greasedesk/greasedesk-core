/**
 * File: lib/affiliate.ts
 * THE AFFILIATE PROGRAMME: who may take the offer, what a referral is worth, and when it is paid.
 *
 * Money paid to people outside the business, on evidence that a garage paid us. Nearly every rule
 * here is about something that must not happen twice, must not exceed a cap, or must not change
 * under somebody's feet after they signed.
 *
 * ── THE TERMS (owner, 2026-10-26) ──────────────────────────────────────────────────────────────
 *   garage on monthly ....... £30 per PAID month, first four paid months only, £120 cap
 *   garage on the offer ..... a single £120 once the annual invoice is PAID
 *   the offer ............... 12 months for the price of 8 (£600), by code, once per garage
 * Earned only on paid invoices: nothing for a trial, an unpaid invoice, a void one, or £0.
 *
 * ── RESELLERS ARE NOT THIS ─────────────────────────────────────────────────────────────────────
 * PartyType.rep is the reseller programme and has its own rate table, taper and pay runs in
 * lib/commission. Nothing here touches it. An affiliate's reward is a FIXED SUM frozen at signup,
 * which is why CommissionEntry.rate_id is nullable: an affiliate entry references no rate because
 * there is no rate to reference.
 */
import { prisma as defaultDb } from '@/lib/db';
import { getProgrammeSettings, type SettingsOpts } from '@/lib/programme-settings';
import {
  planFor, planSettings, writePlanTerms, currentPlanTerms, type PlanSettings, type Plan,
  renewalAnnualPennies, firstYearDiscountPennies, type PlanKind,
} from '@/lib/billing-plans';
import { attributeGroup, type RefMatch } from '@/lib/attribution';

type Db = any; // a PrismaClient or an interactive-transaction client

/**
 * ── THE REWARD FOLLOWS THE MONEY (owner ruling, 2026-10-29) ────────────────────────────────────
 * This replaces REFUND_POLICY_UNDECIDED, a flag that was true, had no reader, and existed to make
 * an unanswered question visible. The question is answered.
 *
 *   A reward becomes PAYABLE 14 days after the invoice that earned it was paid.
 *   If that money goes back, the reward is REVERSED.
 *   If the reward had already been paid out, the reversal stands against FUTURE rewards.
 *
 * ── A REFUND AND A CHARGEBACK ARE NOT ONE EVENT, AND ONLY ONE IS WIRED ─────────────────────────
 * A refund is us giving money back; a chargeback is the bank taking it, and they differ in timing,
 * cost and who decided. The POLICY above covers both and is written into the affiliate terms. The
 * PLUMBING covers the refund half only: `reverseAffiliateReward` is called from
 * lib/commission-billing on charge.refunded. Nothing in this codebase handles charge.dispute.* —
 * the Dispute model is designed and unbuilt — so the chargeback half is on the board against that
 * work rather than claimed here. Said plainly because "the reward follows the money" reads as
 * complete, and today it is complete for one of the two ways money leaves.
 */

/**
 * THE HOLD, IN DAYS. Fourteen, from the paid date of the invoice.
 *
 * DERIVED, NEVER STORED (owner, 2026-10-29). CommissionEntry.status already has a `held` value,
 * but it is an area manager's hold from lib/rep-pay-run::HOLD_REASONS, paired to `held_reason` by
 * a CHECK. A time hold is a different fact, and putting it in those two columns would make a
 * released line indistinguishable from a matured one.
 *
 * A CONSTANT rather than a setting, also deliberately. If the hold length were live and an
 * operator shortened it, money already earned would become payable earlier than the terms the
 * affiliate accepted said — so if it ever needs to move, it belongs in the FROZEN terms
 * (TenantAffiliateTerms), not in ProgrammeSettings. One number here until that day.
 */
export const AFFILIATE_HOLD_DAYS = 14;

/** When a reward earned by an invoice paid at `paidAt` becomes payable. */
export const rewardPayableFrom = (paidAt: Date): Date =>
  new Date(paidAt.getTime() + AFFILIATE_HOLD_DAYS * 24 * 60 * 60 * 1000);

/**
 * Is it payable yet? Three states, not two, and the caller must keep them apart: ACCRUED (earned,
 * inside the hold), PAYABLE (matured), and REVERSED (the money went back). "Not payable" alone
 * would merge the first and the last, and the portal shows them as different things.
 */
export const rewardIsPayable = (a: { paidAt: Date; now?: Date }): boolean =>
  (a.now ?? new Date()).getTime() >= rewardPayableFrom(a.paidAt).getTime();

/** The programme-wide reward terms as they stand today, for a garage signing up now. */
export async function currentTerms(db: Db = defaultDb, opts?: SettingsOpts) {
  const s = await getProgrammeSettings(db, opts);
  return {
    totalRewardPennies: s.total_reward_pennies,
    instalmentPennies: s.instalment_pennies,
    offerMonthsPaid: s.offer_months_paid,
    monthsGiven: s.months_given,
    signupsOpen: s.affiliate_signups_open,
  };
}

/** Change the programme-wide terms. Never touches a garage already referred — see freezeTermsAtSignup. */
export async function saveSettings(
  db: Db,
  patch: Partial<{ totalRewardPennies: number; instalmentPennies: number; offerMonthsPaid: number; monthsGiven: number; signupsOpen: boolean }>,
  opts?: SettingsOpts,
) {
  await getProgrammeSettings(db, opts); // the row exists, created from the schema's defaults
  const data: Record<string, unknown> = {};
  if (patch.totalRewardPennies !== undefined) data.total_reward_pennies = patch.totalRewardPennies;
  if (patch.instalmentPennies !== undefined) data.instalment_pennies = patch.instalmentPennies;
  if (patch.offerMonthsPaid !== undefined) data.offer_months_paid = patch.offerMonthsPaid;
  if (patch.monthsGiven !== undefined) data.months_given = patch.monthsGiven;
  if (patch.signupsOpen !== undefined) data.affiliate_signups_open = patch.signupsOpen;
  return db.programmeSettings.update({ where: { id: opts?.settingsId ?? 'singleton' }, data });
}

/**
 * FREEZE WHAT THIS GARAGE WAS PROMISED, at signup, once.
 *
 * The whole settings design rests on this: an operator may change the reward tomorrow, and a
 * garage referred today keeps what it was referred under. The terms are COPIED, not referenced.
 *
 * It writes the PLAN terms too, in the same call, because they are one fact about one moment —
 * "what this garage signed up under" is both the reward and the shape, and recording them apart
 * invites them to disagree. The plan row goes through lib/billing-plans' writePlanTerms, which is
 * the append-only timeline chokepoint.
 */
export async function freezeTermsAtSignup(
  db: Db,
  groupId: string,
  terms: {
    affiliateId: string;
    totalRewardPennies: number;
    instalmentPennies: number;
    plan?: PlanKind;
    offerMonthsPaid?: number;
    monthsGiven?: number;
    at?: Date;
  },
  opts?: SettingsOpts,
) {
  // NAMED, NOT ASSUMED. Without this the undefined reaches Prisma as a validation error whose
  // message is about a required relation, which reads as a schema problem rather than a caller
  // that did not say who referred the garage.
  if (!terms.affiliateId) throw new Error('freezeTermsAtSignup: affiliateId is required — terms about a referral must name who referred');
  const at = terms.at ?? new Date();
  // THE SETTINGS IN FORCE AT THIS MOMENT, read ONCE and used for both the freeze and the plan row.
  // Read unconditionally rather than only when a plan is being written: the offer has to be frozen
  // whether or not this signup also records a shape, which is the defect this repairs.
  const base = await planSettings(db, opts);
  const settings = {
    ...base,
    ...(terms.offerMonthsPaid !== undefined ? { offerMonthsPaid: terms.offerMonthsPaid } : {}),
    ...(terms.monthsGiven !== undefined ? { monthsGiven: terms.monthsGiven } : {}),
  };

  const row = await db.tenantAffiliateTerms.upsert({
    where: { group_id: groupId },
    update: {},   // WRITTEN ONCE. A second signup for the same garage is not a re-pricing.
    create: {
      group_id: groupId,
      affiliate_id: terms.affiliateId,
      total_reward_pennies: terms.totalRewardPennies,
      instalment_pennies: terms.instalmentPennies,
      signed_up_at: at,
      // WHAT THE GARAGE GETS, frozen beside what the affiliate earns (owner, 2026-10-29). The
      // renewal months are deliberately absent: that is the list price, not a promise.
      offer_months_paid: settings.offerMonthsPaid,
      months_given: settings.monthsGiven,
    },
  });
  if (terms.plan) {
    const existing = await currentPlanTerms(db, groupId);
    if (!existing) await writePlanTerms(db, groupId, planFor(terms.plan, settings), { at });
  }
  return row;
}

/** What this garage was promised. Null when it was never referred by an affiliate. */
export async function termsFor(db: Db, groupId: string) {
  return db.tenantAffiliateTerms.findUnique({ where: { group_id: groupId } });
}

/** The affiliate attributed to this garage, or null. Role 'referrer', party_type 'affiliate'. */
async function affiliateFor(db: Db, groupId: string) {
  return db.tenantAttribution.findFirst({
    where: { group_id: groupId, party_type: 'affiliate', ended_at: null },
    orderBy: { effective_from: 'desc' },
    select: { party_id: true, share_bp: true },
  });
}

export type RewardOutcome =
  | { paid: false; why: string }
  | { paid: true; amountPennies: number; entryId: string };

/**
 * A PAID INVOICE MAY EARN A REWARD. The only writer of an affiliate CommissionEntry.
 *
 * ── WHAT IT REFUSES, AND WHY EACH IS NAMED ─────────────────────────────────────────────────────
 * `status` is REQUIRED and must be 'paid'. Not defaulted: a caller that forgets would otherwise
 * be handed a payment, and the one thing this function does is move money outward.
 *
 * £0 IS CHECKED AS A NUMBER. `if (!paidPennies)` would skip a zero invoice silently and read
 * exactly like refusing it; a fully discounted month is a real invoice marked paid, and it owes
 * nobody anything. Zero is a measurement, not an absence.
 *
 * ── IDEMPOTENT ON THE INVOICE ──────────────────────────────────────────────────────────────────
 * source_ref is the Stripe invoice id, and @@unique([source_ref, party_id, kind]) does the real
 * work. A re-delivered webhook is the normal case, not the exception, so the duplicate is caught
 * by the DATABASE and swallowed here rather than guarded by a read-then-write that two concurrent
 * deliveries would both pass.
 *
 * ── AND THE CAP IS READ INSIDE THE TRANSACTION ─────────────────────────────────────────────────
 * Two webhooks arriving together would both see "under the cap" if it were read outside.
 */
/**
 * ── IS THIS CODE ACTIVE YET, AND WAS IT ACTIVE WHEN THE MONEY ARRIVED? ─────────────────────────
 * Every garage signup mints a personal affiliate code INACTIVE (owner, 2026-10-29). The dashboard
 * carries a one-click "Activate your referral code" that records real acceptance of the terms in
 * Rep.terms_accepted_at — so NULL there means "has accepted nothing", which is exactly what that
 * column has always meant for a rep.
 *
 * THE RULE, AND IT IS A DATE COMPARISON NOT A BOOLEAN: a referral made before activation is still
 * ATTRIBUTED, and is credited FROM ACTIVATION ONWARDS. So an invoice paid before the code was
 * activated earns nothing, and the next one earns normally. `rewardPaidInvoice` is therefore given
 * the date the invoice was PAID rather than reading the clock — with the clock, a webhook
 * re-delivered after activation would pay out a month that happened before it.
 *
 * The activation screen states this rule. It has to: the alternative is an affiliate learning it
 * from a reward that never arrived.
 */
export function refuseUnactivated(a: { termsAcceptedAt: Date | null | undefined; paidAt: Date }): string | null {
  if (!a.termsAcceptedAt) return 'this referral code has not been activated, so it earns nothing yet';
  if (a.paidAt.getTime() < a.termsAcceptedAt.getTime()) {
    return `this invoice was paid before the code was activated (${a.paidAt.toISOString().slice(0, 10)} < ${a.termsAcceptedAt.toISOString().slice(0, 10)}), and rewards run from activation onwards`;
  }
  return null;
}

/**
 * ── NO EARNING ON A GARAGE YOU OWN OR WORK FOR — CHECKED AT ACCRUAL (owner, 2026-10-29) ────────
 * refuseSelfReferral already runs at SIGNUP, against what was typed into the form. That is not
 * enough: the relationship can change afterwards. Somebody refers a garage, and six months later
 * joins it as staff — at which point every further invoice would pay them for working where they
 * work. The signup check cannot see that, because it ran before it happened.
 *
 * So this asks the question again, at the moment money would move, against the CURRENT users of
 * the garage.
 *
 * ── EMAIL ONLY, AND THE PHONE COMPARISON IS DELIBERATELY ABSENT ────────────────────────────────
 * The first draft also compared `Rep.phone_e164` against `User.phone_e164`. There is no such
 * column: `User.phone` is a free-text HR profile field an admin can edit, and the VERIFIED number
 * lives on `TwoFactorSecret.phone_e164`, keyed by subject — a table that answers "what handset did
 * this person prove for a second factor", which is a different question. Reaching through it for
 * an ownership test would be a weaker signal pulled from a table that means something else, and
 * the draft would have thrown a Prisma validation error at the moment money moves.
 *
 * So the test is the affiliate's LOGIN ADDRESS against the garage's users' login addresses. Both
 * are `@unique`, both are credentials, and the same person using the same address on both sides is
 * the ordinary case this is for. (refuseSelfReferral at signup does compare a phone, because there
 * it is comparing what was typed into one form against another — not two stored columns.)
 *
 * WHAT IT CANNOT SEE, stated rather than implied: a person using a different email at the garage
 * than on their affiliate account, and ownership not expressed as a user account at all. Those are
 * a judgement, and the Engine Room's suspend is the answer to them.
 */
export async function refuseOwnOrWorkFor(
  db: Db,
  a: { groupId: string; partyId: string },
): Promise<string | null> {
  const rep = await db.rep.findUnique({ where: { id: a.partyId }, select: { email: true } });
  if (!rep) return null; // no partner row to compare; affiliateFor already found an attribution
  const users = await db.user.findMany({ where: { group_id: a.groupId }, select: { email: true } });
  const repEmail = norm(rep.email);
  if (!repEmail) return null;
  return users.some((u: { email: string | null }) => norm(u.email) === repEmail)
    ? 'the affiliate is a user of this garage, and nobody earns on a garage they own or work for'
    : null;
}

export async function rewardPaidInvoice(
  db: Db,
  args: { groupId: string; invoiceId: string; paidPennies: number; status: string; paidAt: Date },
): Promise<RewardOutcome> {
  if (!args.status) throw new Error('rewardPaidInvoice: status is required — a reward is paid on evidence, not on assumption');
  if (args.status !== 'paid') return { paid: false, why: `invoice is ${args.status}, not paid` };
  if (!Number.isInteger(args.paidPennies) || args.paidPennies <= 0) {
    return { paid: false, why: `invoice took ${args.paidPennies} pennies — a reward is a share of money actually taken` };
  }
  // REQUIRED, not defaulted to now (2026-10-29). Two rules below are date comparisons against it —
  // the activation cut-off and the period this entry belongs to — and a webhook re-delivered a
  // month later would answer both of them wrongly from the clock.
  if (!(args.paidAt instanceof Date) || Number.isNaN(args.paidAt.getTime())) {
    throw new Error('rewardPaidInvoice: paidAt is required — the activation rule and the period are both dated from when the money arrived, not from now');
  }

  const terms = await termsFor(db, args.groupId);
  if (!terms) return { paid: false, why: 'this garage was not referred by an affiliate' };
  const attribution = await affiliateFor(db, args.groupId);
  if (!attribution) return { paid: false, why: 'no live affiliate attribution for this garage' };

  // ── TWO GATES BEFORE THE CAP ARITHMETIC (owner rulings, 2026-10-29) ─────────────────────────
  // Both answer "may THIS affiliate earn on THIS garage", and both can only be answered now:
  // activation may have happened after the referral, and employment may have happened after both.
  const rep = await db.rep.findUnique({ where: { id: attribution.party_id }, select: { terms_accepted_at: true, suspended_at: true } });
  const unactivated = refuseUnactivated({ termsAcceptedAt: rep?.terms_accepted_at ?? null, paidAt: args.paidAt });
  if (unactivated) return { paid: false, why: unactivated };
  const ownOrWorkFor = await refuseOwnOrWorkFor(db, { groupId: args.groupId, partyId: attribution.party_id });
  if (ownOrWorkFor) return { paid: false, why: ownOrWorkFor };

  const plan = await currentPlanTerms(db, args.groupId);
  const isOffer = plan?.plan === 'annual_offer';

  // ONE ENTRY ON THE OFFER, INSTALMENTS ON MONTHLY — and both stop at the same total.
  const already = (await db.commissionEntry.aggregate({
    where: { group_id: args.groupId, party_type: 'affiliate', party_id: attribution.party_id, kind: 'accrual' },
    _sum: { amount_pennies: true },
  }))._sum.amount_pennies ?? 0;
  const remaining = terms.total_reward_pennies - already;
  if (remaining <= 0) return { paid: false, why: `the £${(terms.total_reward_pennies / 100).toFixed(2)} cap for this garage is already reached` };

  const wanted = isOffer ? terms.total_reward_pennies : terms.instalment_pennies;
  const amount = Math.min(wanted, remaining);

  try {
    const entry = await db.commissionEntry.create({
      data: {
        group_id: args.groupId,
        party_type: 'affiliate',
        party_id: attribution.party_id,
        // THE MONTH THE MONEY ARRIVED, not the month this code ran. A webhook re-delivered across a
        // month boundary would otherwise file the same invoice's reward under two different periods
        // and a pay run would read one of them as new work.
        period: args.paidAt.toISOString().slice(0, 7),
        kind: 'accrual',
        tier: 'affiliate',
        revenue_stream: 'subscription',
        // NULL, and the CHECK allows it: an affiliate's reward is a fixed sum frozen at signup,
        // so there is no CommissionRate row for it to point at. A rate id here would be a lie.
        rate_id: null,
        share_bp: attribution.share_bp,
        amount_pennies: amount,
        currency: 'GBP',
        source_ref: args.invoiceId,
        payment_ref: args.invoiceId,
        status: 'pending',   // explicit, for the reason above
        // NULL = THERE IS NO VISIT IN THIS PROGRAMME. Not false, which would claim a visit was
        // expected and did not happen; an affiliate never visits anybody.
        shown_as_visited: null,
      },
      select: { id: true },
    });
    return { paid: true, amountPennies: amount, entryId: entry.id };
  } catch (e: any) {
    // P2002 on [source_ref, party_id, kind] — this invoice has already paid. The normal case.
    if (e?.code === 'P2002') return { paid: false, why: 'this invoice has already earned its reward' };
    throw e;
  }
}

/**
 * ── THE REWARD FOLLOWS THE MONEY BACK (owner ruling, 2026-10-29) ───────────────────────────────
 * Money we took has been given back, so the reward it earned is reversed. One clawback entry per
 * refund, carrying the NEGATIVE of what was accrued for that invoice — never the refunded amount,
 * which is a different number: a £75 month earns £30, and refunding the £75 reverses the £30.
 *
 * PARTIAL REFUNDS ARE REVERSED IN FULL, and that is a decision rather than an oversight. The
 * reward is a flat sum for a paid month, not a share of it, so there is no fraction of it that
 * corresponds to a fraction of the invoice. A garage refunded £20 of a £75 month did not pay for
 * that month on the terms the reward was for. If that ever needs to be proportional it needs the
 * owner, not a rule invented here.
 *
 * ALREADY PAID OUT? The entry still goes in. CommissionEntry is a ledger and a clawback against a
 * paid accrual is exactly how "set against future rewards" is expressed — the pay run sums the
 * ledger, so a negative line reduces the next payout rather than demanding money back. Nothing
 * here chases anybody.
 *
 * IDEMPOTENT on the REFUND id, not the invoice id: one invoice can be refunded twice, and the
 * unique index is on [source_ref, party_id, kind] so two refunds of one invoice are two rows while
 * a re-delivered event is none.
 */
export async function reverseAffiliateReward(
  db: Db,
  args: { groupId: string; refundId: string; invoiceId: string; refundedAt: Date },
): Promise<{ reversed: false; why: string } | { reversed: true; amountPennies: number; entryId: string }> {
  // DATED FROM THE REFUND, not the clock — the same rule as paidAt on the accrual. lib/commission
  // does `periodOf(r.refunded_at)` for exactly this reason, and a reversal filed in the wrong
  // month is a pay run that reads it as new work.
  if (!(args.refundedAt instanceof Date) || Number.isNaN(args.refundedAt.getTime())) {
    throw new Error('reverseAffiliateReward: refundedAt is required — the period is the month the money went back');
  }
  const attribution = await affiliateFor(db, args.groupId);
  if (!attribution) return { reversed: false, why: 'no live affiliate attribution for this garage' };

  // WHAT WAS ACCRUED FOR THIS INVOICE, by this affiliate. Summed rather than read as one row: the
  // monthly shape writes one entry per invoice, but summing is correct for both shapes and cannot
  // be wrong if a second accrual for one invoice ever becomes legitimate.
  const accrued = (await db.commissionEntry.aggregate({
    where: {
      group_id: args.groupId, party_type: 'affiliate', party_id: attribution.party_id,
      kind: 'accrual', source_ref: args.invoiceId,
    },
    _sum: { amount_pennies: true },
  }))._sum.amount_pennies ?? 0;
  if (accrued <= 0) return { reversed: false, why: 'this invoice earned no affiliate reward, so there is nothing to reverse' };

  // ALREADY REVERSED, by an earlier refund of the same invoice? Sum what the clawbacks have taken
  // back and never take back more than went out.
  const clawed = Math.abs((await db.commissionEntry.aggregate({
    where: {
      group_id: args.groupId, party_type: 'affiliate', party_id: attribution.party_id,
      kind: 'clawback', payment_ref: args.invoiceId,
    },
    _sum: { amount_pennies: true },
  }))._sum.amount_pennies ?? 0);
  const remaining = accrued - clawed;
  if (remaining <= 0) return { reversed: false, why: 'this invoice’s reward has already been reversed in full' };

  try {
    const entry = await db.commissionEntry.create({
      data: {
        group_id: args.groupId,
        party_type: 'affiliate',
        party_id: attribution.party_id,
        // THE MONTH THE MONEY WENT BACK, which is when this reversal belongs in a pay run — not
        // the month it was earned, which has very likely already been paid.
        period: args.refundedAt.toISOString().slice(0, 7),
        kind: 'clawback',
        tier: 'affiliate',
        revenue_stream: 'subscription',
        rate_id: null,
        share_bp: attribution.share_bp,
        // NEGATIVE, because the ledger is summed. A positive clawback would read as a second
        // reward on every screen that adds the column up.
        amount_pennies: -remaining,
        currency: 'GBP',
        // THE REFUND is the identity, so two refunds of one invoice are two rows and a re-delivered
        // event is none. payment_ref stays the INVOICE, which is what ties the pair together.
        source_ref: args.refundId,
        payment_ref: args.invoiceId,
        shown_as_visited: null,
        // EXPLICIT, not left to the column default, matching lib/commission's own reasoning: the
        // writer should say which state it is creating, so a changed default is a new value here
        // rather than a silent one.
        status: 'pending',
      },
      select: { id: true },
    });
    return { reversed: true, amountPennies: -remaining, entryId: entry.id };
  } catch (e: any) {
    if (e?.code === 'P2002') return { reversed: false, why: 'this refund has already reversed its reward' };
    throw e;
  }
}

/** A trial earns nothing. Present so the absence is stated rather than left to a missing call. */
export async function rewardTrialStarted(_db: Db, _args: { groupId: string }): Promise<RewardOutcome> {
  return { paid: false, why: 'a trial has paid nothing, so it earns nothing' };
}

/** Why this garage may not take the affiliate offer, or null when it may. */
export function refuseOffer(a: { code: string | null; codeValid: boolean; hasNeverPaid: boolean; alreadyTaken: boolean; signupsOpen: boolean }): string | null {
  // THE SWITCH GATES THE OFFER, NEVER THE ATTRIBUTION (owner, 2026-10-28). It decides whether a new
  // garage may have the 12-for-8 price, not whether affiliates may join and not whether a referral
  // is recorded — a garage that arrives on a link is credited to the affiliate either way, because
  // who introduced them is a fact and the discount is a decision. The old wording, "the affiliate
  // programme is closed to new signups", read as though it stopped affiliates signing up, which is
  // a thing nothing in this file controls.
  if (!a.signupsOpen) return 'The affiliate offer is not available to new garages at the moment.';
  if (!a.code) return 'The affiliate offer needs a referral code.';
  if (!a.codeValid) return 'That referral code is not one we recognise.';
  // NOT "has never been trialing" (owner ruling, 2026-10-29 — THIS REVERSES 2026-10-28). The old
  // flag was named isNewGarage and meant "no subscription has ever reached trialing", so the offer
  // was lost by pressing Monthly at signup and switching to Yearly an hour later, while the garage
  // that left the toggle alone kept £300. A trial is not a purchase. What ends the offer is money
  // having changed hands — and `alreadyTaken` still stops a second one.
  if (!a.hasNeverPaid) return 'The affiliate offer is for a garage that has not yet paid for GreaseDesk.';
  if (a.alreadyTaken) return 'This garage has already taken the affiliate offer.';
  return null;
}

/**
 * ── REVERSED 2026-10-28: ANNUAL MAY CARRY A TRIAL, AND MUST ────────────────────────────────────
 * This refused annual-with-a-trial, under the 2026-10-24 rule that the trial WAS the annual
 * discount taken at the front. The offer changed: every garage gets the trial whatever it
 * picks, and is charged its plan when the trial ends. What is left to refuse is a plan with NO
 * trial at all, which no longer describes anything we sell — on monthly it would be service given
 * away with nothing to charge later, and on annual it would contradict what signup promised.
 */
export function refusePlanCombination(a: { plan: PlanKind | string; trialDays: number }): string | null {
  if (a.trialDays <= 0) return 'Every plan is sold with a trial; a plan with none is not one we offer.';
  return null;
}

/**
 * MAY THIS GARAGE HAVE THE AFFILIATE OFFER, AND WHAT DOES IT PAY? One server-side resolver, read
 * from the groupId and NEVER from request input — the screen that shows the price and the API that
 * charges it both call this, so they cannot disagree. Same discipline as checkout.ts's
 * "both halves or neither" price check, and the same reason settingsId is never taken from a body.
 *
 * A garage that is attributed but refused the offer STAYS ATTRIBUTED and is quoted the renewal
 * price (owner, 2026-10-28). The affiliate still earns: rewardPaidInvoice reads the frozen terms
 * and the attribution, and has never read affiliate_signups_open.
 */
export async function offerFor(
  db: Db,
  groupId: string,
  opts?: SettingsOpts & { settings?: PlanSettings },
): Promise<{
  plan: Extract<PlanKind, 'annual_offer' | 'annual_renewal'>;
  annualPennies: number;
  discountPennies: number;
  refusal: string | null;
  attributed: boolean;
  /** WHO introduced them, resolved HERE so no caller re-derives which party is the referrer. */
  referrerId: string | null;
  /** Their name, for telling the garage whose offer it is. Null when the rep row has gone. */
  referrerName: string | null;
  /** Months CHARGED for by the plan resolved above — the frozen offer, or the live renewal. */
  monthsPaid: number;
  /** Months of service that buys. Frozen with the offer; live otherwise. */
  monthsGiven: number;
  /** True when the figures came from this garage's frozen terms rather than today's settings. */
  offerFrozen: boolean;
}> {
  // ONE SETTINGS READ PER REQUEST (owner, 2026-10-29). A caller that has already read them passes
  // them in: plan-choice read them separately, so the screen could show a price from one read
  // beside a month count from another — a self-contradiction a garage would notice before we did.
  const s = opts?.settings ?? await planSettings(db, { settingsId: opts?.settingsId });
  const terms = await currentTerms(db, opts);
  const renewal = renewalAnnualPennies(s);

  const attribution = await affiliateFor(db, groupId);
  const frozen = attribution ? await termsFor(db, groupId) : null;

  // HAS THIS GARAGE EVER PAID US? (owner ruling, 2026-10-29, REVERSING the 2026-10-28 definition
  // of "never had a subscription that reached active OR trialing".) Read from the billing cache,
  // which is Stripe's truth projected, not from our own guess at it.
  const billing = await db.groupBilling.findUnique({
    where: { group_id: groupId },
    select: { subscription_status: true, stripe_subscription_id: true, first_paid_at: true },
  });
  // TWO SOURCES, BECAUSE ONE OF THEM ONLY STARTS ON 2026-10-29. first_paid_at is the real answer
  // and is written by the invoice.paid handler the first time a non-zero invoice is paid. A garage
  // that paid us before that column existed has none, and reading it alone would hand the offer to
  // an established paying tenant the day an affiliate link finally resolved against its signup_ref.
  // So the subscription status is read alongside, limited to the states a subscription can only be
  // in AFTER its trial produced a chargeable invoice. 'trialing' is deliberately NOT among them —
  // that is the whole of the ruling. Nor are 'canceled' and 'paused', which a trial reaches
  // without ever being billed.
  const BILLED_STATES = ['active', 'past_due', 'unpaid'];
  const everPaid = !!billing?.first_paid_at
    || (!!billing?.stripe_subscription_id && BILLED_STATES.includes(String(billing.subscription_status ?? '')));

  // ── ALREADY TOOK IT = PAID UNDER IT (owner ruling, 2026-10-29) ───────────────────────────────
  // Was: "a TenantPlanTerms row naming the offer exists". That made holding the offer for an hour
  // during a trial the same as having spent it, so Yearly → Monthly → Yearly inside one trial cost
  // the garage £300 for pressing a button twice. Nothing had been collected. The offer is spent
  // when money moves under it: an annual_offer row AND a non-zero invoice actually paid.
  //
  // NOTE FOR A LATER READER: under the companion ruling (hasNeverPaid) this is now almost always
  // subsumed — a garage with first_paid_at set is refused before reaching here. It is kept as a
  // separate rule because the two answer different questions, and the day "never paid" is relaxed
  // (say, monthly payers become eligible) this one becomes load-bearing again on its own.
  const heldOffer = await db.tenantPlanTerms.findFirst({ where: { group_id: groupId, plan: 'annual_offer' }, select: { id: true } });
  const taken = !!heldOffer && !!billing?.first_paid_at;

  // The attribution IS the code, resolved: refuseOffer's `code`/`codeValid` pair asks "was a code
  // given" and "was it real", and at this point both are answered by whether a referrer is on
  // record. The frozen terms are read alongside because a referral with no terms is a garage that
  // was attributed before the terms existed — real, and still entitled to the offer.
  const referrer = attribution ? (frozen?.affiliate_id ?? attribution.party_id) : null;
  const refusal = refuseOffer({
    code: referrer,
    codeValid: !!attribution,
    hasNeverPaid: !everPaid,
    alreadyTaken: !!taken,
    signupsOpen: terms.signupsOpen,
  });

  // ── FROZEN FIRST (owner ruling, 2026-10-29) ──────────────────────────────────────────────────
  // The garage's first year is whatever it was referred under. The RENEWAL stays live, by the same
  // ruling: it is the list price, and Stripe holds the amount once they subscribe. Because the
  // discount is derived as renewal − first year, a later change to the renewal months moves the
  // COUPON and leaves the frozen first-year amount exactly where it was.
  const frozenOffer = frozen?.offer_months_paid ?? null;
  const effective: PlanSettings = frozenOffer === null ? s : {
    ...s, offerMonthsPaid: frozenOffer, monthsGiven: frozen?.months_given ?? s.monthsGiven,
  };
  const discount = refusal ? 0 : firstYearDiscountPennies(effective);
  const resolvedPlan: Extract<PlanKind, 'annual_offer' | 'annual_renewal'> = refusal ? 'annual_renewal' : 'annual_offer';
  // THE NAME, FROM THE SAME `referrer` THE DECISION USED. Looked up only when there is one, and
  // only ever read for display — a missing rep row makes the name null and changes no entitlement.
  const rep = referrer ? await db.rep.findUnique({ where: { id: referrer }, select: { name: true } }) : null;
  return {
    plan: resolvedPlan,
    annualPennies: renewal,          // the SUBSCRIPTION amount, always the renewal figure
    discountPennies: discount,       // taken off the FIRST invoice only, via a duration:'once' coupon
    refusal,
    attributed: !!attribution,
    referrerId: referrer,
    referrerName: rep?.name ?? null,
    monthsPaid: resolvedPlan === 'annual_offer' ? effective.offerMonthsPaid : s.renewalAnnualMonthsPaid,
    monthsGiven: resolvedPlan === 'annual_offer' ? effective.monthsGiven : s.monthsGiven,
    offerFrozen: frozenOffer !== null,
  };
}

/**
 * ── THE PLAN THIS GARAGE IS ON, WITH ITS OWN MONTHS (owner ruling, 2026-10-29) ──────────────────
 * `planFor` is pure and reads whatever settings it is handed. That is the right shape for it, and
 * it is exactly why three callers quietly got the wrong answer: each handed it TODAY's settings
 * for a garage whose offer was frozen months ago. Checkout C charged £450 from offerFor while the
 * webhook wrote `paid_now_pennies 60000 / months_paid 8` into TenantPlanTerms from the live
 * setting — the record of what a garage agreed to contradicting the money it was charged.
 *
 * So this is the one place that answers "what plan is this garage on, and for how many months".
 * It resolves the SHAPE through offerFor (frozen-aware) and hands planFor settings whose offer
 * months are the ones actually being charged for. planFor stays pure; what changes is that nobody
 * passes it live settings for a garage whose offer is frozen.
 *
 * The RENEWAL months are deliberately not overridden — they are the list price (same ruling), so
 * an annual_renewal plan is priced from today's settings, which is correct.
 *
 * Pass `offer` when the caller has already resolved it, and `settings` when it has already read
 * them: one read per request is the companion rule, and this function must not undo it.
 */
export async function planForGarage(
  db: Db,
  groupId: string,
  shape: 'monthly' | PlanKind,
  opts: {
    settings?: PlanSettings;
    sites?: number;
    settingsId?: string;
    offer?: Awaited<ReturnType<typeof offerFor>>;
  } = {},
): Promise<{ plan: Plan; offer: Awaited<ReturnType<typeof offerFor>> | null }> {
  const settings = opts.settings ?? await planSettings(db, { settingsId: opts.settingsId });
  const sites = Math.max(1, Math.trunc(opts.sites ?? 1));
  if (shape === 'monthly') return { plan: planFor('monthly', settings, sites), offer: null };

  const offer = opts.offer ?? await offerFor(db, groupId, { settings, settingsId: opts.settingsId });
  // THE MONTHS offerFor ACTUALLY CHARGED FOR. For annual_offer that is the frozen figure; for
  // annual_renewal planFor reads renewalAnnualMonthsPaid, which this leaves alone on purpose.
  const effective: PlanSettings = { ...settings, offerMonthsPaid: offer.monthsPaid, monthsGiven: offer.monthsGiven };
  return { plan: planFor(offer.plan, effective, sites), offer };
}

const norm = (v: string | null | undefined) => (v ?? '').trim().toLowerCase();
const digits = (v: string | null | undefined) => (v ?? '').replace(/\D/g, '').replace(/^44/, '0');

/**
 * NOBODY REFERS THEMSELVES. Compared on normalised email, phone and company — a phone matches
 * across +447…/07… formatting, and a company across case and spacing, because the three cheap
 * disguises are a different case, a different format and a trailing space.
 */
export function refuseSelfReferral(
  affiliate: { email?: string | null; phone?: string | null; company?: string | null },
  garage: { email?: string | null; phone?: string | null; company?: string | null },
): string | null {
  if (norm(affiliate.email) && norm(affiliate.email) === norm(garage.email)) return 'That is the affiliate’s own email address.';
  const a = digits(affiliate.phone), g = digits(garage.phone);
  if (a && a === g) return 'That is the affiliate’s own phone number.';
  if (norm(affiliate.company) && norm(affiliate.company) === norm(garage.company)) return 'That is the affiliate’s own business.';
  return null;
}


// ── WHO REFERRED THIS GARAGE, RECORDED AT THE MOMENT THE GARAGE IS CREATED ──────────────────────

/** Named outcomes, because "not attributed" has to be SAYABLE: each one needs different words. */
export type SignupAttribution = {
  attributed: boolean;
  reason: 'attributed' | 'no_code' | 'unknown_code' | 'ambiguous_code' | 'suspended' | 'self_referral' | 'already_referred';
  /** What to show the person signing up. Null when there is nothing to say (no code, or it worked). */
  message: string | null;
  partyId?: string;
  partyType?: string;
};

/** The public wording for each outcome. One place, so the signup page and the code checker agree. */
export function attributionMessage(reason: SignupAttribution['reason'], detail?: string | null): string | null {
  switch (reason) {
    case 'attributed': return null;
    case 'no_code': return null;
    case 'unknown_code': return 'That referral code is not one we recognise, so no referral has been recorded. Everything else about your account is unaffected.';
    case 'ambiguous_code': return 'That referral code matches more than one account, so we have not guessed. Please check it with whoever gave it to you.';
    case 'suspended': return 'That referral code is no longer active, so no referral has been recorded. Everything else about your account is unaffected.';
    case 'self_referral': return detail ?? 'A referral code cannot be used on your own account, so no referral has been recorded.';
    case 'already_referred': return 'This garage is already recorded against a referrer, and a referral is never changed afterwards.';
  }
}

/**
 * ATTRIBUTE THE GARAGE AND FREEZE WHAT IT WAS PROMISED — IN THE GARAGE'S OWN TRANSACTION.
 *
 * ── WHY IT IS IN THE TRANSACTION ───────────────────────────────────────────────────────────────
 * Attribution used to run AFTER the signup transaction, best-effort and swallowed, which was the
 * right shape while a ref was a dormant marketing string. It is money now. A garage created with
 * its referral silently dropped is not a garage missing a field: it is an affiliate who introduced
 * a customer and will never be paid, discovered weeks later when somebody asks why. Committing the
 * garage and the record of who sent them together means there is no interval in which one is true
 * and the other is not.
 *
 * The LOOKUP is deliberately outside: findPartyByRefCode is a read, it is the part that can fail
 * for reasons that have nothing to do with this garage, and a failed lookup must leave the signup
 * standing. Pass the match in. Everything in here is a write, and a write that fails SHOULD take
 * the signup with it.
 *
 * ── AND IT NEVER REFUSES A SIGNUP ──────────────────────────────────────────────────────────────
 * Every non-match returns `attributed: false` with words for it. An unknown code is a typo, not a
 * reason to turn away a paying customer at the door.
 */
export async function attributeAtSignup(
  tx: Db,
  args: {
    groupId: string;
    match: RefMatch;
    garage: { email?: string | null; phone?: string | null; company?: string | null };
    at?: Date;
  },
  opts?: SettingsOpts,
): Promise<SignupAttribution> {
  const { match } = args;
  const at = args.at ?? new Date();
  const no = (reason: SignupAttribution['reason'], detail?: string | null): SignupAttribution =>
    ({ attributed: false, reason, message: attributionMessage(reason, detail) });

  if (match.status === 'none') return no('no_code');
  if (match.status === 'ambiguous') return no('ambiguous_code');
  if (match.status === 'suspended') return no('suspended');

  // NOBODY REFERS THEMSELVES — checked before anything is written, not cleaned up afterwards.
  const self = refuseSelfReferral(
    { email: match.email, phone: match.phone, company: match.name },
    args.garage,
  );
  if (self) return no('self_referral', self);

  const written = await attributeGroup(tx, {
    groupId: args.groupId, partyId: match.partyId, partyType: match.partyType, effectiveFrom: at,
  });
  // A GARAGE IS REFERRED ONCE. attributeGroup refuses to add a second active attribution, and that
  // refusal is reported rather than resolved: changing who a garage belongs to is an operator act.
  if ('conflict' in written) return no('already_referred');

  // The reward terms are frozen HERE, in the same transaction, for the same reason the attribution
  // is: an operator may change the programme tomorrow and this garage keeps today's terms. Only an
  // affiliate has reward terms — a rep is paid from the commission rate table, not a frozen sum.
  if (match.partyType === 'affiliate') {
    const terms = await currentTerms(tx, opts);
    await freezeTermsAtSignup(tx, args.groupId, {
      affiliateId: match.partyId,
      totalRewardPennies: terms.totalRewardPennies,
      instalmentPennies: terms.instalmentPennies,
      at,
    }, opts);
  }

  return { attributed: true, reason: 'attributed', message: null, partyId: match.partyId, partyType: match.partyType };
}
