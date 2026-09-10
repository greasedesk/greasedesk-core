/**
 * File: lib/prospects.ts
 * THE RULES FOR A PROSPECT — pure, and a LEAF: it reaches no database, so the rep's pages can read it
 * without shipping PrismaClient to a phone on a forecourt (leaf-module-for-client-constants; the rep
 * sign-in page lost all its client JavaScript to exactly that, one day before this file existed).
 *
 * ── WHO THIS RECORD IS FOR ──────────────────────────────────────────────────────────────────────
 * Not the rep. It is for whoever picks up the trail six months after the rep has gone: who was
 * spoken to, when, and what was said. Every choice below is made for that reader.
 *
 * ── NOT A PIPELINE ──────────────────────────────────────────────────────────────────────────────
 * Four statuses, deliberately. Funnel stages come later, once there are real notes to learn them
 * from — stages invented before the evidence are stages the evidence then has to fit.
 */

export const PROSPECT_STATUSES = ['spoke_to', 'interested', 'not_interested', 'signed_up'] as const;
export type ProspectStatus = (typeof PROSPECT_STATUSES)[number];
export const STATUS_LABEL: Record<ProspectStatus, string> = {
  spoke_to: 'Spoke to them',
  interested: 'Interested',
  not_interested: 'Not interested',
  signed_up: 'Signed up',
};
export const isProspectStatus = (s: unknown): s is ProspectStatus => PROSPECT_STATUSES.includes(s as ProspectStatus);

/**
 * CONSENT IS AN ANSWER TO A QUESTION, NOT A FEATURE OF AN ADDRESS. `not_asked` is a value on a NOT
 * NULL column and consent_at is the nullable one — the due-items shape — because "not asked" is an
 * absence, and an absence must never read as a yes.
 */
export const CONSENT_STATES = ['not_asked', 'agreed', 'declined'] as const;
export type ConsentState = (typeof CONSENT_STATES)[number];

/**
 * WHY A SEQUENCE STOPPED. A stopped sequence always carries one — ProspectSequence_stop_chk refuses
 * a stop with no reason — because "stopped" alone tells the next reader nothing.
 */
export const STOP_REASONS = ['unsubscribed', 'signed_up', 'already_customer', 'completed', 'suppressed', 'retention'] as const;
export type StopReason = (typeof STOP_REASONS)[number];
export const STOP_LABEL: Record<StopReason, string> = {
  unsubscribed: 'Stopped — they unsubscribed',
  signed_up: 'Stopped — they signed up',
  already_customer: 'Stopped — that address already belongs to a customer',
  completed: 'Finished — every email in the sequence was sent',
  suppressed: 'Never started — that address had unsubscribed before',
  retention: 'Stopped — personal data removed after 24 months',
};

/** Why the PERSON'S data was removed. The garage's record is never removed. */
export const STRIP_REASONS = ['retention', 'unsubscribed', 'signed_up'] as const;
export type StripReason = (typeof STRIP_REASONS)[number];

/** How long a named person and their email are kept after the LAST visit, for a non-customer. */
export const RETENTION_MONTHS = 24;

/**
 * THE SEQUENCE. Roughly weekly, as briefed. The copy and the video link are the owner's and are
 * NOT WRITTEN YET — these templates carry placeholders (lib/notification-templates, prospect_step_*).
 * `afterDays` is measured from the PREVIOUS send, not from enrolment, so a step that could not be
 * sent (provider down) is not followed immediately by the next one when it finally goes.
 */
export const SEQUENCE = [
  { step: 1, template: 'prospect_step_1', afterDays: 0 },
  { step: 2, template: 'prospect_step_2', afterDays: 7 },
  { step: 3, template: 'prospect_step_3', afterDays: 7 },
] as const;
export type SequenceTemplate = (typeof SEQUENCE)[number]['template'];

// ── NORMALISATION — the keys a duplicate is presented by ─────────────────────────────────────────
/**
 * A GARAGE NAME REDUCED TO WHAT A SECOND REP WOULD ALSO TYPE. Lower-case, punctuation gone, spaces
 * collapsed, and "ltd"/"limited" dropped — the one word two people spell differently about the SAME
 * business. Deliberately NOT dropping "garage", "motors" or "autos": "Smith Motors" and "Smith
 * Garage" can be two different businesses on one street, and a key that merges them presents a
 * false match a tired rep may accept.
 */
export function nameKey(name: string): string {
  return name.toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\b(ltd|limited)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** UK postcode with the spaces gone and upper-cased. NULL for a blank — never an empty key. */
export function postcodeKey(pc: string | null | undefined): string | null {
  const k = String(pc ?? '').toUpperCase().replace(/\s+/g, '');
  return k === '' ? null : k;
}

/**
 * THE ADDRESS AS STORED AND AS COMPARED — ONE FUNCTION FOR BOTH. The suppression hash and the
 * existing-customer check compare this exact string; normalising it differently in two places is how
 * an unsubscribed address gets written to again (identical-by-construction).
 */
export function normaliseEmail(e: string | null | undefined): string | null {
  const k = String(e ?? '').trim().toLowerCase();
  return k === '' ? null : k;
}
export const looksLikeEmail = (e: string | null) => !!e && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);

// emailHash and newUnsubscribeToken live in lib/prospect-keys — they need `crypto`, and this file
// is read by the rep's phone. It imports NOTHING, so it can never carry a server dependency there.

// ── THE DECISIONS, PURE ──────────────────────────────────────────────────────────────────────────
/**
 * MAY THIS PROSPECT BE ENROLLED? Every condition, named, so a refusal says which.
 * An address alone is never enough: the owner must have AGREED, and the rep must have recorded it.
 */
export type EnrolRefusal = 'no_email' | 'no_consent' | 'stripped' | 'signed_up';
export function refuseEnrolment(p: {
  email: string | null; consent: string; personal_stripped_at: Date | null; status: string;
}): EnrolRefusal | null {
  if (p.personal_stripped_at) return 'stripped';
  if (p.status === 'signed_up') return 'signed_up';
  if (!p.email) return 'no_email';
  if (p.consent !== 'agreed') return 'no_consent';
  return null;
}

/**
 * WHAT HAPPENS TO AN ENROLMENT AFTER A SUCCESSFUL SEND. Pure, so the gate can prove the schedule
 * without a clock. The last step ends it as `completed` — a stop with a reason, like every other.
 */
export function afterSend(step: number, now: Date):
  | { state: 'active'; next_step: number; next_due_at: Date }
  | { state: 'stopped'; stopped_reason: 'completed' } {
  const next = SEQUENCE.find((s) => s.step === step + 1);
  if (!next) return { state: 'stopped', stopped_reason: 'completed' };
  return { state: 'active', next_step: next.step, next_due_at: new Date(now.getTime() + next.afterDays * 86_400_000) };
}

/** Is this record old enough that the person's data must go? Measured from the LAST visit. */
export function pastRetention(lastVisit: Date, now: Date): boolean {
  const cutoff = new Date(now);
  cutoff.setUTCMonth(cutoff.getUTCMonth() - RETENTION_MONTHS);
  return lastVisit.getTime() < cutoff.getTime();
}
