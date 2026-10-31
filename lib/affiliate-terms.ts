/**
 * File: lib/affiliate-terms.ts
 * THE AFFILIATE TERMS: which document they are, what the figures in them resolve to, and what an
 * acceptance records.
 *
 * ── WHY A DOCUMENT AND NOT PROSE IN A .tsx ──────────────────────────────────────────────────────
 * The page stays a FILE route — pages/affiliate-site/terms.tsx — because admitting [slug] to the
 * affiliate host's allow-list would expose every published document on that host, garage policies
 * included; that reasoning is in the page's own header and is unchanged. What moves into the content
 * system is only the BODY, resolved server-side by slug. The host stays shut and the terms gain a
 * version, a date, an editor and a history.
 *
 * ── THE FIGURES ARE SUBSTITUTED, AND THERE IS A TENSION HERE WORTH NAMING ───────────────────────
 * The owner's instruction is that the figures come from settings rather than being typed into the
 * prose, so a reward change cannot leave the terms contradicting the programme. The cost is that
 * the published body is no longer self-contained: change `total_reward_pennies` and the text of
 * version 2026-11-01 changes under it, so the version stamp alone no longer reproduces what an
 * affiliate accepted.
 *
 * TODAY THAT IS ACCEPTABLE AND NOT INVISIBLE: the reward settings have moved once, the acceptance
 * row records the version, and an affiliate's own per-garage terms are frozen separately in
 * TenantAffiliateTerms — which is what actually governs what they are paid. The fix, when it is
 * worth it, is to BAKE the substitution at publish time so the stored body is literal; that is a
 * change to the content publish path and is boarded rather than smuggled in here.
 */
import type { PrismaClient } from '@prisma/client';

/** The content-system slug. Also read by lib/affiliate-portal-data for the portal's footer. */
export const AFFILIATE_TERMS_SLUG = 'affiliate-terms';

/**
 * UNDEFINED IS ALLOWED, and it is how a figure that has no value TODAY keeps its placeholder visible
 * rather than resolving to a blank. rewardFigures().instalmentLabel is legitimately null when there
 * is no instalment to label, and `{{instalment}}` printing as itself is the loud outcome.
 */
export type TermsFigures = Record<string, string | number | undefined>;

/**
 * SUBSTITUTE {{name}} FROM THE FIGURES, AND LEAVE AN UNKNOWN ONE VISIBLE.
 *
 * An unrecognised placeholder renders as itself — `{{whatever}}` — rather than as a blank. A blank
 * is the dangerous outcome: "you earn  for each of a garage's 12 months" reads as finished prose
 * with a word missing and would be published without anybody noticing. The literal braces are
 * exactly as loud as the gap markers the content editor already relies on.
 */
export function fillTerms(body: string, figures: TermsFigures): string {
  return String(body ?? '').replace(/\{\{([a-zA-Z][a-zA-Z0-9_]{0,40})\}\}/g, (whole, key: string) => {
    const v = figures[key];
    return v === undefined || v === null ? whole : String(v);
  });
}

/** Which placeholders are left unfilled — for the Engine Room, so a gap is seen before publishing. */
export function unfilledPlaceholders(body: string, figures: TermsFigures): string[] {
  const out = new Set<string>();
  for (const m of String(body ?? '').matchAll(/\{\{([a-zA-Z][a-zA-Z0-9_]{0,40})\}\}/g)) {
    if (figures[m[1]] === undefined) out.add(m[1]);
  }
  return [...out];
}

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
