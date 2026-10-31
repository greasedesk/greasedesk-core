/**
 * File: lib/affiliate-portal-data.ts
 * EVERYTHING THE AFFILIATE DASHBOARD SHOWS, SHAPED SERVER-SIDE.
 *
 * ── THE OMISSION IS THE MECHANISM ───────────────────────────────────────────────────────────────
 * The same discipline pages/rep/index.tsx records: what is not in the select cannot be in the props,
 * so no component can render it by accident and no later edit can uncover it. Here the withheld
 * fields are:
 *
 *   • bank_sort_code and bank_account_number — never selected, never decrypted on this path. The
 *     screen shows `account_last4`, which is why that column exists. A reveal is owner-only and
 *     audited; an affiliate looking at their own dashboard must not write an audit row, and must not
 *     be able to read the digits back out of a page they can leave open on a forecourt.
 *   • every garage column except its name and lifecycle status (the owner's instruction). No
 *     revenue, no reward per garage, no contact — an affiliate introduced a business, they did not
 *     acquire a view into it.
 *   • CommissionEntry.held_reason, release_override_reason, shown_as_visited — the pay-run's private
 *     assessment, scanned for by name in the gate exactly as rep-invoice-gate scans the rep page.
 */
import type { PrismaClient } from '@prisma/client';
import { prisma as defaultDb } from '@/lib/db';
import { getProgrammeSettings } from '@/lib/programme-settings';
import { resolvePublished } from '@/lib/content';
import { referralLink } from '@/lib/affiliate-join';
import { earningsFrom, heldSchedule, AFFILIATE_HOLD_DAYS, type Earnings } from '@/lib/affiliate-earnings';
import { howItWorks, socialPosts, PAYOUT_CADENCE, type HowStep, type SocialPost } from '@/lib/affiliate-portal-copy';
import { maskedForAffiliate } from '@/lib/payee';
import { AFFILIATE_TERMS_SLUG } from '@/lib/affiliate-terms';
import { COMPANY } from '@/lib/company-info';

type Db = PrismaClient;

/** The ER-editable video list's slug. The TERMS slug belongs to lib/affiliate-terms and is imported
 * rather than repeated — the public page, the signup's acceptance row and this portal all have to
 * mean the same document, and two spellings of a slug resolve to two documents in silence. */
export const VIDEO_SLUG = 'affiliate-videos';
export { AFFILIATE_TERMS_SLUG };

/**
 * ── THE FOUR LABELS COME FROM THE ENUM, NOT FROM A GUESS AT WHICH THREE MATTER ──────────────────
 * The owner asked for three words: trial, paying, cancelled. TenantStatus has FOUR values, and the
 * fourth is `suspended`.
 *
 * Folding suspended into "cancelled" would tell an affiliate a garage is gone when it is an account
 * we have paused and may unpause — a plausible wrong word, which outlives an implausible one. So
 * there is a fourth label, and the mapping is exhaustive over the enum rather than over the three
 * cases somebody thought of.
 *
 * `active` is rendered "Paying" because that is the affiliate's question. It is NOT cross-checked
 * against first_paid_at: that column is read for the Engine Room's own "has this ever been worth
 * anything" and overlaying it here would invent a fifth state nobody asked for.
 */
export const GARAGE_STATUS_LABEL: Record<string, string> = {
  trial: 'Trial',
  active: 'Paying',
  suspended: 'Paused',
  cancelled: 'Cancelled',
};

export type PortalGarage = { name: string; status: string };
export type PortalVideo = { title: string; url: string };
export type PayeeState = 'none' | 'pending' | 'held';

export type PortalData = {
  name: string;
  refCode: string;
  referralLink: string;
  /** Suspension stops NEW attribution and never touches earned rewards — so the portal still opens. */
  suspended: boolean;
  garages: PortalGarage[];
  earnings: Earnings;
  /** When each still-held accrual matures. ISO dates; the page formats them. */
  held: Array<{ amountPennies: number; payableFrom: string }>;
  minimumPayoutPennies: number;
  cadence: string;
  holdDays: number;
  howItWorks: HowStep[];
  posts: SocialPost[];
  payee: { state: PayeeState; masked: string | null; accountName: string | null };
  videos: PortalVideo[];
  terms: { currentVersion: string | null; acceptedVersion: string | null; acceptedAt: string | null };
};

/**
 * ── THE VIDEO SLOTS, AND WHY A MARKDOWN LIST IS THE WHOLE FEATURE ───────────────────────────────
 * The owner fills these from the Engine Room, and "empty slots hidden" is the requirement. A table
 * of slots would need a migration, a screen and an ordering; a published Document already has an
 * editor, a country axis, versioning and a safe renderer — and an absent document is an absent
 * section with nothing to arrange.
 *
 * ONE LINE PER VIDEO: `- [Title](https://…)`. Anything else in the body is ignored rather than
 * guessed at. A parser that tried to make sense of prose would be a parser widened for prose, and
 * the failure mode — a half-read line rendering as a broken link on somebody's dashboard — is worse
 * than the line simply not appearing.
 *
 * TITLED LINKS, NOT EMBEDS (owner, 2026-10-31). The safe markdown renderer does not pass iframes,
 * and widening a sanitiser so an operator-edited page can inject frames is not a thing to do for a
 * launch nicety.
 */
export function parseVideoList(body: string): PortalVideo[] {
  const out: PortalVideo[] = [];
  for (const line of String(body ?? '').split('\n')) {
    const m = /^\s*[-*]\s*\[([^\]]{1,120})\]\((https?:\/\/[^\s)]{1,500})\)\s*$/.exec(line);
    if (m) out.push({ title: m[1].trim(), url: m[2] });
  }
  return out;
}

export async function affiliatePortalData(repId: string, db: Db = defaultDb as Db, now: Date = new Date()): Promise<PortalData | null> {
  const rep = await db.rep.findUnique({
    where: { id: repId },
    // NO bank_sort_code, NO bank_account_number. See the header: the omission is the mechanism.
    select: {
      id: true, name: true, ref_code: true, party_type: true, suspended_at: true,
      bank_account_name: true, bank_account_last4: true,
    },
  });
  if (!rep || rep.party_type !== 'affiliate') return null;

  const settings = await getProgrammeSettings(db);

  const terms = await db.tenantAffiliateTerms.findMany({
    where: { affiliate_id: rep.id },
    orderBy: { signed_up_at: 'desc' },
    select: { group_id: true },
  });
  const groups = terms.length
    ? await db.group.findMany({
      where: { id: { in: terms.map((t) => t.group_id) } },
      select: { id: true, group_name: true, status: true },
    })
    : [];
  const groupById = new Map(groups.map((g) => [g.id, g]));

  const entries = await db.commissionEntry.findMany({
    where: { party_type: 'affiliate', party_id: rep.id },
    // THREE COLUMNS DELIBERATELY ABSENT — see the header.
    select: { kind: true, amount_pennies: true, created_at: true },
  });

  /**
   * THE PENDING REQUEST DECIDES WHAT THE AFFILIATE IS TOLD, not what we would pay. Only its last4
   * is read; the ciphertext stays in the row until the owner reveals it on the approval screen.
   */
  const pending = await db.repPayeeRequest.findFirst({
    where: { rep_id: rep.id, status: 'pending' },
    orderBy: { requested_at: 'desc' },
    select: { account_last4: true, account_name: true },
  });

  const held = rep.bank_account_last4 ? 'held' : 'none';
  const payeeState: PayeeState = pending ? 'pending' : (held as PayeeState);

  const videoDoc = await resolvePublished(db, VIDEO_SLUG, 'GB');
  const termsDoc = await resolvePublished(db, AFFILIATE_TERMS_SLUG, 'GB');
  const accepted = await db.repTermsAcceptance.findFirst({
    where: { rep_id: rep.id },
    orderBy: { accepted_at: 'desc' },
    select: { version: true, accepted_at: true },
  });

  const link = referralLink(rep.ref_code, COMPANY.siteUrl);
  return {
    name: rep.name,
    refCode: rep.ref_code,
    referralLink: link,
    suspended: !!rep.suspended_at,
    garages: terms.map((t) => {
      const g = groupById.get(t.group_id);
      return {
        // A GARAGE WITH NO NAME YET IS NORMAL: signup writes a placeholder and onboarding asks for
        // the real one. Saying so beats printing an empty cell — listAffiliates says the same.
        name: g?.group_name ?? '(not named yet)',
        status: GARAGE_STATUS_LABEL[g?.status ?? ''] ?? 'Unknown',
      };
    }),
    earnings: earningsFrom(entries, now),
    held: heldSchedule(entries, now).map((h) => ({ amountPennies: h.amountPennies, payableFrom: h.payableFrom.toISOString().slice(0, 10) })),
    minimumPayoutPennies: settings.minimum_payout_pennies,
    cadence: PAYOUT_CADENCE,
    holdDays: AFFILIATE_HOLD_DAYS,
    howItWorks: howItWorks({
      holdDays: AFFILIATE_HOLD_DAYS,
      monthsGiven: settings.months_given,
      monthsPaid: settings.offer_months_paid,
    }),
    posts: socialPosts({ referralLink: link, monthsGiven: settings.months_given, monthsPaid: settings.offer_months_paid }),
    payee: {
      state: payeeState,
      masked: pending?.account_last4
        ? maskedForAffiliate(pending.account_last4)
        : (rep.bank_account_last4 ? maskedForAffiliate(rep.bank_account_last4) : null),
      accountName: pending?.account_name ?? rep.bank_account_name ?? null,
    },
    videos: videoDoc ? parseVideoList(videoDoc.body) : [],
    terms: {
      currentVersion: termsDoc?.version ?? null,
      acceptedVersion: accepted?.version ?? null,
      acceptedAt: accepted?.accepted_at ? accepted.accepted_at.toISOString().slice(0, 10) : null,
    },
  };
}
