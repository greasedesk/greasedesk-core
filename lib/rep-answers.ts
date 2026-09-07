/**
 * File: lib/rep-answers.ts
 * WHAT A REP WRITES UP AFTER A VISIT — and the one answer that becomes a lead.
 *
 * ── THREE-STATE, FOLLOWING `not_raised` RATHER THAN INVENTING A SECOND SHAPE ────────────────────
 * lib/due-items already settled this: `not_raised` is a VALUE on a NOT NULL column, and
 * `response_at` is the nullable one, because "nobody answered" is an absence rather than an answer
 * at time-unknown. Every answer here is shaped the same way, and answeredAtFor below is
 * responseAtFor with a different name.
 *
 * Using NULL for "not asked" would have collided with the two answers where the NEGATIVE IS REAL
 * and is the commercially useful thing:
 *   · "they are not interested"        — the lead outcome. NULL would erase it.
 *   · "nothing is missing, we're happy" — a genuine reply, and `''` normalised to NULL destroys it.
 * The other two carry their negatives as values already (`problems`, `barely`), so nothing in this
 * file is ever null to mean "not asked", and nothing can collide with it.
 *
 * There is NO DEFAULT on any of them, for the reason due-items gives: a surface that pre-selects
 * one makes the negative vanishingly rare while looking like it is recording it, and that failure
 * is silent.
 *
 * ── WHERE EACH RULE LIVES, AND WHY IT IS NOT THE OTHER PLACE ───────────────────────────────────
 * The whats_missing pairing is a CHECK in Postgres: it is a shape rule ("said carries text, the
 * other two do not") and a shape is what a constraint is good at. `problems` requiring prose is a
 * REFUSAL here instead: the database can say a note is non-empty, it cannot say it is a
 * description, and a constraint that enforces half a rule invites the reader to believe it
 * enforces the whole one.
 *
 * ── DORMANT ────────────────────────────────────────────────────────────────────────────────────
 * Nothing reads an answer or a lead. rep-answers-gate pins that, so a first reader has to be a
 * deliberate act rather than a drift.
 */

export const APP_WORKING = ['working', 'problems', 'not_asked'] as const;
export const USING_IT = ['daily', 'sometimes', 'barely', 'not_asked'] as const;
export const WHATS_MISSING = ['not_asked', 'nothing', 'said'] as const;
export const LEAD_INTEREST = ['interested', 'not_interested', 'not_asked'] as const;
/** What WE did about the lead. Deliberately carries no `not_asked`: see the note on refuseLead. */
export const LEAD_STATUS = ['open', 'converted', 'declined'] as const;

export type AppWorking = (typeof APP_WORKING)[number];
export type UsingIt = (typeof USING_IT)[number];
export type WhatsMissing = (typeof WHATS_MISSING)[number];
export type LeadInterest = (typeof LEAD_INTEREST)[number];
export type LeadStatus = (typeof LEAD_STATUS)[number];

export const NOT_ASKED = 'not_asked';

/**
 * The time an answer was given, or NULL when it was not given.
 *
 * lib/due-items::responseAtFor, borrowed whole: only an ANSWER is an event. `not_asked` means
 * nobody answered — an absence, not an answer at time-unknown — so the column stays null and a
 * reader can tell the two apart. Note that a NEGATIVE answer still stamps: "nothing is missing"
 * was asked and answered, which is the entire reason it is a value rather than a null.
 */
export const answeredAtFor = (value: string, now: Date): Date | null => (value === NOT_ASKED ? null : now);

export type AnswerRefusal = { code: string; message: string };

const blank = (s: string | null | undefined): boolean => !s || s.trim() === '';
const oneOf = (set: readonly string[], v: unknown): boolean => typeof v === 'string' && set.includes(v);

export type AnswerInput = {
  appWorking: AppWorking;
  appWorkingNote: string | null;
  usingIt: UsingIt;
  whatsMissingState: WhatsMissing;
  whatsMissingText: string | null;
};

/**
 * The answers, checked as a set.
 *
 * `problems` REQUIRES prose. A recorded problem with no description is a ticket nobody can action:
 * it looks like a signal on every dashboard that counts it and answers no question anyone can act
 * on. This is a refusal rather than a CHECK because judging "is this a description" is judgement —
 * the constraint could only demand non-emptiness, and half a rule in the database reads as the
 * whole rule to the next person.
 *
 * Prose is WELCOME anywhere, only REQUIRED beside a problem: a rep noting "they love the diary" on
 * a `working` answer is recording something worth having.
 */
export function refuseAnswer(a: AnswerInput): AnswerRefusal | null {
  if (!oneOf(APP_WORKING, a.appWorking) || !oneOf(USING_IT, a.usingIt) || !oneOf(WHATS_MISSING, a.whatsMissingState)) {
    return { code: 'bad_value', message: 'One of the answers is not a value this form offers.' };
  }
  if (a.appWorking === 'problems' && blank(a.appWorkingNote)) {
    return { code: 'problem_undescribed', message: 'Say what the problem was — a recorded problem nobody described cannot be acted on.' };
  }
  // THE PAIRING, mirrored from the CHECK rather than replacing it. Three real states and four
  // representable combinations is how the fourth becomes nonsense nobody prevents.
  const wantsText = a.whatsMissingState === 'said';
  if (wantsText === blank(a.whatsMissingText)) {
    return {
      code: 'missing_text',
      message: wantsText
        ? 'Say what they told you was missing.'
        : 'Remove the note, or change the answer to say they told you something.',
    };
  }
  return null;
}

/** All three asked. `not_asked` IS the incomplete state — which is what makes a "needs writing up"
 *  list possible at all. Derived on every read, never stored: a stored flag drifts from its inputs. */
export function answersComplete(a: Pick<AnswerInput, 'appWorking' | 'usingIt' | 'whatsMissingState'>): boolean {
  return a.appWorking !== NOT_ASKED && a.usingIt !== NOT_ASKED && a.whatsMissingState !== NOT_ASKED;
}

export type LeadInput = { interest: LeadInterest; status: LeadStatus; closedAt: Date | null };

/**
 * The lead, checked as a set.
 *
 * INTEREST AND STATUS ARE TWO AXES and must not be collapsed into one. `interest` is what the
 * garage SAID; `status` is what we then DID. A lead can be open with interest `not_asked` (the rep
 * ran out of time) or open with interest `interested` (they said yes and nobody has followed up) —
 * different queues, and a single field would hide the second, which is the expensive one.
 *
 * That is also why `status` carries no `not_asked`: a lead that exists is one we are holding, and
 * "we have not decided what to do" is `open`.
 */
export function refuseLead(l: LeadInput): AnswerRefusal | null {
  if (!oneOf(LEAD_INTEREST, l.interest) || !oneOf(LEAD_STATUS, l.status)) {
    return { code: 'bad_value', message: 'That is not a value this form offers.' };
  }
  if ((l.status === 'open') !== (l.closedAt === null)) {
    return {
      code: 'bad_closure',
      message: l.status === 'open'
        ? 'An open lead has not been closed, so it cannot carry a closing date.'
        : 'Say when the lead was closed.',
    };
  }
  return null;
}

/**
 * ── THE EDIT TRAIL, AND WHY IT IS NOT AuditLog ─────────────────────────────────────────────────
 * AuditLog is the TENANT's trail: it is group-scoped, cascade-deleted with the tenant, and a garage
 * can read theirs. What a rep recorded about a garage — that the app is causing them problems, that
 * they barely use it, that they are shopping for card payments — is not the garage's to read. One
 * line in the wrong table publishes it to the subject of the assessment.
 *
 * So it goes to SuperAdminAudit, the platform ledger, which already holds the actions no tenant
 * sees. The actor is a REP rather than an operator, which is why that table gained `actor_rep_id`:
 * `operator_user_id` NULL already means "the platform itself acted", and a second nullable actor
 * would have blurred that sentinel without a column of its own.
 *
 * NOT CALLED YET. There is no surface that writes an answer, so nothing edits one. This is the
 * writer that surface will use, landing with the model it audits rather than after it.
 */
export type AnswerEdit = {
  visitId: string;
  groupId: string;
  groupNameSnapshot: string;
  actorRepId: string | null;
  operatorUserId: string | null;
  before: unknown;
  after: unknown;
};

export async function auditAnswerEdit(db: { superAdminAudit: { create: (a: unknown) => Promise<unknown> } }, e: AnswerEdit): Promise<void> {
  await db.superAdminAudit.create({
    data: {
      operator_user_id: e.operatorUserId,
      actor_rep_id: e.actorRepId,
      action: 'rep.answer_edited',
      target_group_id: e.groupId,
      target_name_snapshot: e.groupNameSnapshot,
      detail: { visitId: e.visitId, before: e.before, after: e.after },
    },
  });
}
