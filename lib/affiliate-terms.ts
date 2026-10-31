/**
 * File: lib/affiliate-terms.ts
 * THE AFFILIATE TERMS: which document they are, what the figures in them resolve to, and what an
 * acceptance records.
 *
 * ── WHY A DOCUMENT AND NOT PROSE IN A .tsx ──────────────────────────────────────────────────────
 * The page stays a FILE route — pages/affiliate-site/terms.tsx — because admitting [slug] to the
 * affiliate host's allow-list would expose every published document on that host, garage policies
 * included; that reasoning is in the page's own header and is unchanged. What lives in the content
 * system is only the BODY, resolved server-side by slug. The host stays shut and the terms gain a
 * version, a date, an editor and a history.
 *
 * ── THE FIGURES ARE BAKED AT PUBLISH, NOT SUBSTITUTED AT RENDER (owner, 2026-10-31) ─────────────
 * The first version of this substituted `{{totalReward}}` and the rest every time the page was
 * rendered. That satisfied the instruction — no figure typed into the prose, so a reward change
 * could not leave the terms contradicting the programme — and bought a worse problem: the published
 * body was no longer self-contained. Move `total_reward_pennies` and the text of version 2026-10-31
 * changed underneath it, so the version stamp an affiliate accepted no longer reproduced the words
 * they agreed to.
 *
 * Now the substitution happens ONCE, when the version is published, and what is stored is literal.
 * A published version is therefore immutable in fact as well as in policy, and
 * RepTermsAcceptance.version identifies exactly one set of words for ever. The consequence is the
 * owner's, stated: CHANGING A SETTING MEANS PUBLISHING A NEW VERSION. Nothing reaches back.
 *
 * It also means a publish that changes no prose but follows a settings change is NOT a no-op —
 * the baked body differs — which is why lib/content-publish bakes BEFORE it asks whether the
 * publish would be identical.
 */
import type { PrismaClient } from '@prisma/client';
import { COMPANY, officeOneLine } from '@/lib/company-info';
import { AFFILIATE_HOLD_DAYS } from '@/lib/affiliate-earnings';
import { programmeMoney } from '@/lib/affiliate-public';

/** The content-system slug. Read by the public page, the signup's acceptance row and the portal. */
export const AFFILIATE_TERMS_SLUG = 'affiliate-terms';

/**
 * WHICH DOCUMENTS GET FIGURES BAKED IN. A registry, not a rule about every document: a garage's
 * privacy notice has no `{{totalReward}}` in it and must not acquire a substitution pass that could
 * silently alter it. Adding a slug here is a decision, and the publish path refuses an unresolved
 * placeholder, so a document joining this list cannot be published half-filled.
 */
export const FIGURE_BAKED_SLUGS: ReadonlySet<string> = new Set([AFFILIATE_TERMS_SLUG]);

export type TermsFigures = Record<string, string | number>;

/**
 * ── THE FIGURES, RESOLVED FROM SETTINGS, NEVER TYPED ───────────────────────────────────────────
 * Every one comes from the same resolver the public pages use — rewardFigures for the reward,
 * publicPlanChoice for the garage's offer, ProgrammeSettings for the trial and the payout minimum,
 * AFFILIATE_HOLD_DAYS for the hold. So the terms and the site cannot quote different money.
 *
 * `paidMonths` is rewardFigures' own FLOOR of total ÷ instalment, not arithmetic repeated here. At
 * £120 and £50 the honest answer is two instalments and a cap, and that file already decided it.
 */
export async function termsFigures(db: PrismaClient): Promise<TermsFigures> {
  const { currentTerms } = await import('@/lib/affiliate');
  const { rewardFigures } = await import('@/lib/affiliate-public');
  const { publicPlanChoice } = await import('@/lib/plan-choice');
  const { getProgrammeSettings } = await import('@/lib/programme-settings');

  const terms = await currentTerms(db);
  const f = rewardFigures({ totalRewardPennies: terms.totalRewardPennies, instalmentPennies: terms.instalmentPennies });
  const choice = await publicPlanChoice(db, { referred: true });
  const settings = await getProgrammeSettings(db);

  return {
    legalName: COMPANY.legalName,
    companyNumber: COMPANY.companyNumber,
    officeAddress: officeOneLine(),
    totalReward: f.totalLabel,
    // A MONTHLY SPLIT MAY NOT EXIST. With instalmentPennies at 0 there are no instalments and no
    // "first N paid months"; the placeholders resolve to a dash rather than to "null" or to a
    // silently plausible 0, and the publish refusal below is what stops a body that needs them
    // going out in that state.
    instalment: f.instalmentLabel ?? '—',
    paidMonths: f.paidMonths ?? '—',
    monthsGiven: choice.annual.monthsGiven,
    monthsPaid: choice.annual.monthsPaid,
    offerPrice: choice.annual.totalLabel,
    renewalPrice: choice.annual.renewalTotalLabel,
    trialDays: settings.trial_days,
    holdDays: AFFILIATE_HOLD_DAYS,
    minimumPayoutSentence: minimumPayoutSentence(settings.minimum_payout_pennies),
  };
}

/**
 * ── THE MINIMUM-PAYOUT SENTENCE, OR NOTHING (owner, 2026-10-31) ────────────────────────────────
 * A minimum of zero means there is no minimum, and "The minimum payout is £0.00" is worse than
 * silence: it reads as a rule, and a reader would wonder what it excludes. So the whole SENTENCE is
 * the substituted value and it is empty when there is nothing to say.
 *
 * THE TRAILING SPACE IS PART OF THE VALUE, and that is deliberate rather than sloppy. The body
 * reads `…of each month. {{minimumPayoutSentence}}The first payouts are…`, so the sentence carries
 * the space that separates it from the next one and an empty value leaves the two sentences
 * correctly spaced. The alternative — collapsing double spaces after substitution — would reach
 * into the markdown table in section 3, where spacing is structure.
 */
export function minimumPayoutSentence(minimumPennies: number): string {
  const pennies = Math.max(0, Math.trunc(minimumPennies ?? 0));
  if (pennies === 0) return '';
  // THE SAME FORMATTER THE REWARD FIGURES USE, so one document cannot say "£120" in section 3 and
  // "£100.00" in section 6. It was doing exactly that until the dry run printed both.
  return `The minimum payout is ${programmeMoney(pennies)}; `
    + 'a smaller balance carries forward to the next run. ';
}

const PLACEHOLDER = /\{\{([a-zA-Z][a-zA-Z0-9_]{0,40})\}\}/g;

/**
 * BAKE. Substitutes every known figure and REPORTS what it could not resolve.
 *
 * It does not leave an unknown placeholder visible, as the render-time version did: at publish time
 * the right answer is to refuse, because an immutable legal version carrying `{{whatever}}` cannot
 * be edited afterwards — the whole point of the immutability. A parser that fails closed on a
 * fragment it cannot resolve is correct here; one that guesses is not.
 */
export function bakeFigures(body: string, figures: TermsFigures): { body: string; unfilled: string[] } {
  const unfilled = new Set<string>();
  const baked = String(body ?? '').replace(PLACEHOLDER, (whole, key: string) => {
    const v = figures[key];
    if (v === undefined || v === null) { unfilled.add(key); return whole; }
    return String(v);
  });
  return { body: baked, unfilled: [...unfilled] };
}

/** The refusal, as a sentence naming every placeholder — plural, because one fix at a time is slow. */
export function refuseUnbaked(unfilled: string[]): string | null {
  if (unfilled.length === 0) return null;
  return `This version still has ${unfilled.length} unresolved figure${unfilled.length === 1 ? '' : 's'}: `
    + `${unfilled.map((u) => `{{${u}}}`).join(', ')}. A published legal version is immutable, so it cannot go out `
    + 'with a placeholder in it. Correct the spelling in the draft, or add the figure to lib/affiliate-terms.';
}

/** Any placeholder left in a body — used to assert a PUBLISHED body is literal. */
export const hasPlaceholder = (body: string): boolean => PLACEHOLDER.test(String(body ?? ''));

/**
 * ── RECORD AN ACCEPTANCE. APPEND-ONLY, AND IT NEVER THROWS INTO THE SIGNUP ──────────────────────
 * Called inside the signup transaction, beside the terms_accepted_at stamp, so an acceptance and
 * the row recording it cannot disagree.
 *
 * THE VERSION MAY BE NULL, and that is a real state rather than a failure: before the owner
 * publishes the document, an affiliate accepting at /join accepted the SUMMARY the file route
 * renders, which has no version. Writing 'unknown' or today's date would invent a reference to a
 * document that does not exist — so nothing is written, and Rep.terms_accepted_at remains the whole
 * of what we can honestly say about those signups.
 *
 * Now that the body is baked at publish, the version is a complete answer to "what did they agree
 * to": the words under that stamp cannot change afterwards.
 */
export async function recordTermsAcceptance(
  tx: PrismaClient | any,
  args: { repId: string; version: string | null; documentId?: string | null },
): Promise<boolean> {
  if (!args.version) return false;
  await tx.repTermsAcceptance.create({
    data: { rep_id: args.repId, version: args.version, document_id: args.documentId ?? null },
  });
  return true;
}
