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
import { planFor, planSettings, writePlanTerms, currentPlanTerms, type PlanKind } from '@/lib/billing-plans';
import { attributeGroup, type RefMatch } from '@/lib/attribution';

type Db = any; // a PrismaClient or an interactive-transaction client

/**
 * ── TODO, AWAITING AN OWNER RULING (raised 2026-10-26) ─────────────────────────────────────────
 * WHAT HAPPENS TO A REWARD WHEN THE INVOICE THAT EARNED IT IS REFUNDED OR CHARGED BACK?
 *
 * Nothing here handles it, deliberately, rather than guessing. The mechanism already exists —
 * CommissionEntry.kind is 'accrual' | 'clawback' and the reseller side wires charge.refunded to a
 * clawback — so this is a policy question, not a plumbing one. Two things the ruling has to
 * separate, because they are not the same event: a REFUND is us giving money back, a CHARGEBACK
 * is the bank taking it, and they differ in timing, cost and who decided. Until it is answered, a
 * refunded invoice leaves its reward standing, which is a choice this comment makes visible
 * rather than one the code makes quietly.
 */
export const REFUND_POLICY_UNDECIDED = true;

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
  const row = await db.tenantAffiliateTerms.upsert({
    where: { group_id: groupId },
    update: {},   // WRITTEN ONCE. A second signup for the same garage is not a re-pricing.
    create: {
      group_id: groupId,
      affiliate_id: terms.affiliateId,
      total_reward_pennies: terms.totalRewardPennies,
      instalment_pennies: terms.instalmentPennies,
      signed_up_at: at,
    },
  });
  if (terms.plan) {
    const base = await planSettings(db, opts);
    const settings = {
      ...base,
      ...(terms.offerMonthsPaid !== undefined ? { offerMonthsPaid: terms.offerMonthsPaid } : {}),
      ...(terms.monthsGiven !== undefined ? { monthsGiven: terms.monthsGiven } : {}),
    };
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
export async function rewardPaidInvoice(
  db: Db,
  args: { groupId: string; invoiceId: string; paidPennies: number; status: string },
): Promise<RewardOutcome> {
  if (!args.status) throw new Error('rewardPaidInvoice: status is required — a reward is paid on evidence, not on assumption');
  if (args.status !== 'paid') return { paid: false, why: `invoice is ${args.status}, not paid` };
  if (!Number.isInteger(args.paidPennies) || args.paidPennies <= 0) {
    return { paid: false, why: `invoice took ${args.paidPennies} pennies — a reward is a share of money actually taken` };
  }

  const terms = await termsFor(db, args.groupId);
  if (!terms) return { paid: false, why: 'this garage was not referred by an affiliate' };
  const attribution = await affiliateFor(db, args.groupId);
  if (!attribution) return { paid: false, why: 'no live affiliate attribution for this garage' };

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
        period: new Date().toISOString().slice(0, 7),
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

/** A trial earns nothing. Present so the absence is stated rather than left to a missing call. */
export async function rewardTrialStarted(_db: Db, _args: { groupId: string }): Promise<RewardOutcome> {
  return { paid: false, why: 'a trial has paid nothing, so it earns nothing' };
}

/** Why this garage may not take the affiliate offer, or null when it may. */
export function refuseOffer(a: { code: string | null; codeValid: boolean; isNewGarage: boolean; alreadyTaken: boolean; signupsOpen: boolean }): string | null {
  // THE SWITCH GATES THE OFFER, NEVER THE ATTRIBUTION (owner, 2026-10-28). It decides whether a new
  // garage may have the 12-for-8 price, not whether affiliates may join and not whether a referral
  // is recorded — a garage that arrives on a link is credited to the affiliate either way, because
  // who introduced them is a fact and the discount is a decision. The old wording, "the affiliate
  // programme is closed to new signups", read as though it stopped affiliates signing up, which is
  // a thing nothing in this file controls.
  if (!a.signupsOpen) return 'The affiliate offer is not available to new garages at the moment.';
  if (!a.code) return 'The affiliate offer needs a referral code.';
  if (!a.codeValid) return 'That referral code is not one we recognise.';
  if (!a.isNewGarage) return 'The affiliate offer is for a new garage only.';
  if (a.alreadyTaken) return 'This garage has already taken the affiliate offer.';
  return null;
}

/** Paying at the front and being on trial are contradictory states, not a configuration. */
export function refusePlanCombination(a: { plan: PlanKind | string; trialDays: number }): string | null {
  const annual = String(a.plan).startsWith('annual');
  if (annual && a.trialDays > 0) return 'An annual plan is paid at the front; it cannot also carry a trial.';
  if (!annual && a.trialDays <= 0) return 'A monthly plan with no trial offers neither a trial nor a payment.';
  return null;
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
