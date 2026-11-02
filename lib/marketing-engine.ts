/**
 * File: lib/marketing-engine.ts
 * THE RULES FOR ONE MARKETING SEQUENCE — four audiences, one state machine, and a LEAF: it reaches
 * no database and imports nothing, so the Engine Room screens can read its labels without dragging
 * PrismaClient into a browser bundle (leaf-module-for-client-constants — lib/prospects exists for
 * the same reason, one module at a time).
 *
 * ── WHY THIS REPLACES lib/prospects' SEQUENCE ───────────────────────────────────────────────────
 * That one was the same machine with a single audience welded into its primary key
 * (ProspectSequence.prospect_id @unique → Prospect). A trial garage is a Group, a waiting affiliate
 * is an AffiliateWaitlist row, a new affiliate is a Rep. Four tables, and Postgres has no
 * polymorphic foreign key — so the choice was four nullable subject columns of which one is ever
 * set, or four copies of the runner, the switch, the stop reasons and the cron. This is the third
 * option: one engine, the subject named by a pair.
 *
 * Measured before it was written (2026-11-02, production): Prospect 0 rows, ProspectSequence 0,
 * ProspectSending NO ROW — the old engine had never once been switched on. Generalising it was
 * therefore a schema change over empty tables rather than a data migration, which is the only
 * reason it is the cheap option.
 *
 * ── WHAT IS FROZEN AND WHAT IS READ LIVE ────────────────────────────────────────────────────────
 * An enrolment freezes WHY the send is allowed — the consent source and the moment it was given,
 * because that is what the enrolment was justified by and it must not change under us. It reads
 * LIVE, every single time, what the send is SUBJECT TO: the unsubscribe list, whether the address
 * has become a customer, whether the owner's switch is on, and whether the subject still exists.
 * Freeze the justification, read the constraint (seeded-not-read).
 */

// ── THE FOUR SEQUENCES ───────────────────────────────────────────────────────────────────────────
export const SEQUENCE_KEYS = ['garage_prospect', 'trial_garage', 'affiliate_interest', 'affiliate_new'] as const;
export type SequenceKey = (typeof SEQUENCE_KEYS)[number];
export const isSequenceKey = (k: unknown): k is SequenceKey => SEQUENCE_KEYS.includes(k as SequenceKey);

/**
 * WHICH TABLE subject_id POINTS INTO. Named after the TABLE, never after the sequence, so one word
 * never means two things: `affiliate_interest` is a sequence and `affiliate_waitlist` is a table,
 * and the earlier draft of this file called both of them the same thing
 * (shared-identifier-hides-subject).
 */
export const SUBJECT_TYPES = ['prospect', 'group', 'affiliate_waitlist', 'rep'] as const;
export type SubjectType = (typeof SUBJECT_TYPES)[number];
export const isSubjectType = (t: unknown): t is SubjectType => SUBJECT_TYPES.includes(t as SubjectType);

/**
 * THE ONE SUBJECT TYPE EACH SEQUENCE MAY POINT AT.
 *
 * This is a function, so `subject_type` is strictly derivable from `sequence_key` and the column is
 * redundant — kept anyway, and then held to this map by MarketingEnrolment_pair_chk. A bare uuid in
 * a polymorphic column is unreadable to anyone querying by hand in two years; a type column beside
 * it that CANNOT disagree with the code is self-describing at no risk. Redundant and proved
 * consistent beats absent, and beats redundant and unchecked.
 */
export const SUBJECT_OF: Record<SequenceKey, SubjectType> = {
  garage_prospect: 'prospect',
  trial_garage: 'group',
  affiliate_interest: 'affiliate_waitlist',
  affiliate_new: 'rep',
};

export const SEQUENCE_LABEL: Record<SequenceKey, string> = {
  garage_prospect: 'Garage prospects',
  trial_garage: 'Garages on trial',
  affiliate_interest: 'Affiliate waiting list',
  affiliate_new: 'New affiliates',
};

/** Who receives it, in the words the Engine Room shows above the switch. */
export const SEQUENCE_AUDIENCE: Record<SequenceKey, string> = {
  garage_prospect: 'A garage a rep visited, whose owner agreed to hear from us.',
  trial_garage: 'A garage inside its trial that has never been charged.',
  affiliate_interest: 'Somebody who left their address to be told when the affiliate programme opens.',
  affiliate_new: 'An affiliate who has joined and accepted the terms, but has not referred a garage yet.',
};

// ── THE SCHEDULE ─────────────────────────────────────────────────────────────────────────────────
/**
 * FIVE STEPS, WEEKLY. Step 1 goes the moment the enrolment is created; every later step is measured
 * from the PREVIOUS SEND, not from enrolment — so a step that could not go out (provider down) is
 * not immediately followed by the next one when it finally does.
 */
export const STEPS = 5;
export const STEP_AFTER_DAYS = [0, 7, 7, 7, 7] as const;
export const isStep = (n: unknown): n is number => Number.isInteger(n) && (n as number) >= 1 && (n as number) <= STEPS;

/** Days between the previous send and this step. Step 1 is 0 — it does not wait for the cron. */
export function afterDaysForStep(step: number): number {
  return STEP_AFTER_DAYS[step - 1] ?? 7;
}

// ── HOW A SEQUENCE ENDS ──────────────────────────────────────────────────────────────────────────
/**
 * WHY IT STOPPED. A stopped enrolment always carries one — MarketingEnrolment_state_chk refuses a
 * stop with no reason — because "stopped" on its own tells the next reader nothing at all.
 *
 * `subject_gone` is the one with no equivalent in the old engine, and it exists because this table
 * has no foreign key to its subject. A cascade used to do this silently; now the runner must say it.
 */
export const STOP_REASONS = [
  'completed', 'unsubscribed', 'suppressed', 'already_customer', 'retention',
  'signed_up', 'first_payment', 'joined', 'first_referral', 'subject_gone', 'not_eligible',
] as const;
export type StopReason = (typeof STOP_REASONS)[number];
export const isStopReason = (r: unknown): r is StopReason => STOP_REASONS.includes(r as StopReason);

export const STOP_LABEL: Record<StopReason, string> = {
  completed: 'Finished — every email in the sequence was sent',
  unsubscribed: 'Stopped — they unsubscribed',
  suppressed: 'Never started — that address had unsubscribed before',
  already_customer: 'Stopped — that address already belongs to a customer',
  retention: 'Stopped — personal data removed after 24 months',
  signed_up: 'Stopped — their trial started',
  first_payment: 'Stopped — they paid for the first time',
  joined: 'Stopped — they joined the affiliate programme',
  first_referral: 'Stopped — their first referred garage signed up',
  subject_gone: 'Stopped — the record this was following is no longer there',
  /**
   * NOT A FAILURE AND NOT THE GOAL — they left the audience by some other door. A trial that was
   * cancelled, a tenant that turned out to be a demo, an affiliate who was suspended. It is its own
   * reason because reading `subject_gone` on a garage that is still very much there, or
   * `first_payment` on one that never paid, would send the next reader looking for the wrong event.
   */
  not_eligible: 'Stopped — they are no longer in this sequence’s audience',
};

/**
 * THE STOP EACH SEQUENCE EXISTS TO REACH — the one the owner named when asking for it. Every other
 * reason is a sequence ending for some other cause; this is the one that means it worked.
 *
 * Each already has a column, which is why no table needed adding to know when to stop:
 *   garage_prospect     Prospect.signed_up_at           (a card is taken at signup, so the trial starts)
 *   trial_garage        GroupBilling.first_paid_at      (written once, by the invoice.paid handler)
 *   affiliate_interest  a Rep row appearing with that address
 *   affiliate_new       the first TenantAttribution naming that rep
 */
export const GOAL_STOP: Record<SequenceKey, StopReason> = {
  garage_prospect: 'signed_up',
  trial_garage: 'first_payment',
  affiliate_interest: 'joined',
  affiliate_new: 'first_referral',
};

// ── WHY THE SEND IS ALLOWED ───────────────────────────────────────────────────────────────────────
/**
 * WHERE THE CONSENT CAME FROM, frozen on the enrolment with the moment it was given. Not a boolean:
 * "they agreed" with no record of how is not evidence of anything, and in two years the only
 * question that will be asked about one of these addresses is where it came from.
 */
export const CONSENT_SOURCES = ['rep_visit', 'signup', 'waitlist_form', 'affiliate_terms'] as const;
export type ConsentSource = (typeof CONSENT_SOURCES)[number];
export const isConsentSource = (s: unknown): s is ConsentSource => CONSENT_SOURCES.includes(s as ConsentSource);

export const CONSENT_LABEL: Record<ConsentSource, string> = {
  rep_visit: 'Agreed in person, recorded by the rep who visited',
  signup: 'Signed up for a GreaseDesk trial and accepted the terms',
  waitlist_form: 'Left their address on the affiliate waiting-list form',
  affiliate_terms: 'Joined the affiliate programme and accepted the affiliate terms',
};

/** The source each sequence's enrolments carry. One per sequence, so no caller chooses it. */
export const CONSENT_OF: Record<SequenceKey, ConsentSource> = {
  garage_prospect: 'rep_visit',
  trial_garage: 'signup',
  affiliate_interest: 'waitlist_form',
  affiliate_new: 'affiliate_terms',
};

// ── THE STATE MACHINE, PURE ──────────────────────────────────────────────────────────────────────
/**
 * WHAT HAPPENS AFTER A SUCCESSFUL SEND. Pure, so a gate can prove the whole schedule without a
 * clock and without a database. The last step ends it as `completed` — a stop with a reason, like
 * every other way out.
 */
export function afterSend(step: number, now: Date):
  | { state: 'active'; next_step: number; next_due_at: Date }
  | { state: 'stopped'; stopped_reason: 'completed' } {
  if (step >= STEPS) return { state: 'stopped', stopped_reason: 'completed' };
  const next = step + 1;
  return { state: 'active', next_step: next, next_due_at: new Date(now.getTime() + afterDaysForStep(next) * 86_400_000) };
}

// ── DOES THE SWITCH LET THIS SEND GO? ─────────────────────────────────────────────────────────────
/**
 * THE ONE READER of the sending decision, per sequence. The owner's switch (MarketingSending; NO ROW
 * = OFF) is for everyone on that sequence. A gate's LEASE overrides it for ONE enrolment until it
 * expires, and only when the question names that enrolment — a cron run names none, so no lease ever
 * reaches it.
 *
 * Carried over unchanged from lib/prospects::sendingAllows, including the reason it is a lease and
 * not a flipped switch: the gate used to turn the OWNER'S switch on and restore it in a `finally`,
 * and killed mid-run it left sending ON for every real consented address. Proven by SIGKILLing it,
 * 10 Sep 2026. A lease touches no switch, reaches no enrolment but its own, and stops counting when
 * it expires, so one left behind by a killed process needs nobody to clean up after it.
 */
export const SENDING_LEASE_MAX_SECONDS = 300; // = MarketingSendingLease_short_chk
export type SendingSwitchRow = { enabled: boolean } | null;
export type SendingLeaseRow = { enrolment_id: string; enabled: boolean; expires_at: Date } | null;

export function sendingAllows(owner: SendingSwitchRow, lease: SendingLeaseRow, at: { now: Date; enrolmentId?: string }): boolean {
  const leaseApplies = lease != null && at.enrolmentId != null && lease.enrolment_id === at.enrolmentId
    && at.now.getTime() < lease.expires_at.getTime();
  if (leaseApplies) return lease!.enabled;
  return owner?.enabled === true;
}

// ── WHAT A SEQUENCE IS DOING, AS A PERSON SHOULD READ IT ─────────────────────────────────────────
/**
 * THE ONE DERIVATION, so the Engine Room list, the switch panel and any per-subject view cannot
 * disagree about what is happening.
 *
 * QUEUED IS NEVER SHOWN AS RUNNING. An `active` enrolment is not necessarily sending: with the
 * switch off nothing goes, and with it on, a step that has not gone yet still has not gone. Both
 * read as queued, and only an enrolment that has actually sent something reads as running — because
 * the whole value of this screen is that it says what has happened rather than what was intended.
 *
 * `holding` is the state the old engine could not express: the switch is on and the step is due, but
 * nobody has written its copy, so it waits. Reported, never silently idle.
 */
export type SequenceState =
  | { kind: 'none' }
  | { kind: 'queued'; why: 'switched_off' | 'not_yet_sent' }
  | { kind: 'holding'; step: number }
  | { kind: 'running'; step: number }
  | { kind: 'stopped'; reason: StopReason };

export function enrolmentState(
  row: { state: string; stopped_reason: string | null; last_sent_at: Date | string | null; next_step: number } | null,
  opts: { sendingOn: boolean; hasCopy?: boolean },
): SequenceState {
  if (!row) return { kind: 'none' };
  if (row.state === 'stopped') return { kind: 'stopped', reason: (row.stopped_reason ?? 'completed') as StopReason };
  if (!opts.sendingOn) return { kind: 'queued', why: 'switched_off' };
  if (opts.hasCopy === false) return { kind: 'holding', step: row.next_step };
  if (!row.last_sent_at) return { kind: 'queued', why: 'not_yet_sent' };
  return { kind: 'running', step: row.next_step };
}

/**
 * THE SENTENCE SOMEBODY READS STRAIGHT AFTER AN ENROLMENT IS CREATED. A rep has just promised a
 * garage owner something; this must say whether it has actually happened, and `queued` must never
 * read as `sent`. Carried over from lib/prospects::sequenceSavedSentence, now with `holding`, which
 * that version could not express because copy was compiled in and therefore always present.
 */
export function savedSentence(s: SequenceState): string {
  switch (s.kind) {
    case 'none': return 'Saved. No follow-up emails — no address was given, or they were not asked.';
    case 'queued': return s.why === 'switched_off'
      ? 'Saved. Their follow-up is QUEUED — GreaseDesk has not switched this sequence on yet, so nothing has been emailed to them. It will start from the first email when sending is switched on.'
      : 'Saved. Their follow-up is queued and the first email will go within the hour.';
    case 'holding': return `Saved. Their follow-up is HELD — nobody has written email ${s.step} yet, so nothing has gone.`;
    case 'running': return 'Saved. The first follow-up email from GreaseDesk has been sent.';
    case 'stopped': return `Saved. ${STOP_LABEL[s.reason]}.`;
  }
}

/** Short, for a list row. */
export function stateLabel(s: SequenceState): string {
  switch (s.kind) {
    case 'none': return 'Not enrolled';
    case 'queued': return s.why === 'switched_off'
      ? 'Queued — this sequence has not been switched on'
      : 'Queued — the first email goes within the hour';
    case 'holding': return `Held at email ${s.step} — nobody has written it yet`;
    case 'running': return `Running — email ${s.step} next`;
    case 'stopped': return STOP_LABEL[s.reason];
  }
}

// ── THE COPY ─────────────────────────────────────────────────────────────────────────────────────
/**
 * IS THERE ANYTHING TO SEND? A step with no row, a blank subject or a blank body does NOT go: the
 * runner reports `no_copy` and leaves the enrolment exactly where it is, so nobody receives an empty
 * email and no step is advanced as though it had been sent.
 *
 * Checked here, pure, because the Engine Room must show the same answer the runner will reach —
 * "ready to send" on a screen and a silent hold in the cron is the pair that wastes an afternoon.
 */
export type CopyRow = { subject: string; body: string; cta_label?: string | null; cta_url?: string | null } | null;

export function copyIsSendable(c: CopyRow): boolean {
  return !!c && c.subject.trim() !== '' && c.body.trim() !== '';
}

/**
 * A CALL TO ACTION IS TWO COLUMNS OR NEITHER (MarketingCopy_cta_chk). Returned as a pair or null so
 * no renderer has to decide what a label with no link means.
 */
export function ctaOf(c: CopyRow): { label: string; url: string } | null {
  const label = String(c?.cta_label ?? '').trim();
  const url = String(c?.cta_url ?? '').trim();
  if (!label || !url) return null;
  return { label, url };
}

/**
 * ONLY http(s), AND ONLY AS A WHOLE URL. The owner types this into a box and it becomes an href in a
 * stranger's inbox, so `javascript:` and `data:` are refused here rather than escaped downstream —
 * escaping makes a bad link harmless-looking, refusing makes it absent. A parser refuses rather than
 * guessing: anything that does not parse as an absolute http(s) URL is not one.
 */
export function ctaUrlAllowed(raw: string): boolean {
  try {
    const u = new URL(String(raw).trim());
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

// ── MAY THIS SEQUENCE WRITE TO A CUSTOMER? ───────────────────────────────────────────────────────
/**
 * TWO CORRECT RULES THAT COLLIDED, AND THE CATEGORY THAT WAS MISSING.
 *
 * lib/prospect-suppression refuses any prospecting send to an address belonging to a GreaseDesk User
 * or a tenant's billing address, with the reasoning that "the worst outcome this whole feature can
 * produce is a paying customer receiving prospecting mail". That is right, and it was written when
 * prospecting mail was the only marketing GreaseDesk sent.
 *
 * Two of these four sequences write to exactly those people — a garage inside its trial, and an
 * affiliate who has joined. Routed through that refusal, every one of their emails would be skipped
 * as `already_customer`. Routed around it, they would have no opt-out at all: lib/notify::isSuppressed
 * begins `if (!groupId) return false`, so every PLATFORM send is unsuppressible, which is the defect
 * prospect-suppression was built beside rather than inside.
 *
 * Neither rule is wrong. The missing category is WHO THE AUDIENCE IS, and it belongs here, as data,
 * one answer per sequence — not as an override at the call site, and not as a boolean a caller passes.
 *
 * `garage_prospect` is the only true one, and the reason is not symmetry: a trial garage and a new
 * affiliate are already in a relationship with us, and somebody on the affiliate waiting list may
 * perfectly well be a customer too — the waiting list is about the affiliate programme, not about
 * buying GreaseDesk, so refusing them for being a customer would withhold the thing they asked for.
 */
export const REFUSE_IF_CUSTOMER: Record<SequenceKey, boolean> = {
  garage_prospect: true,
  trial_garage: false,
  affiliate_interest: false,
  affiliate_new: false,
};
