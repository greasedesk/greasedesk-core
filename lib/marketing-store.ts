/**
 * File: lib/marketing-store.ts
 * EVERY WRITE THE MARKETING ENGINE MAKES — enrolling, stopping, sending, switching, and the copy.
 * Server-only. The rules it applies are lib/marketing-engine, which reaches no database.
 *
 * Replaces lib/prospect-store's sequence half. What is carried over, deliberately and almost
 * verbatim, is everything that was already right: the switch that stops the SEND and never the
 * ENROLMENT, the claim-before-send that makes two overlapping runs safe, the rule that an unsent
 * step stays due rather than being skipped as though it had gone, and the insistence that a stopped
 * enrolment says why.
 *
 * ── THE ONE THING FOUR AUDIENCES DO DIFFERENTLY ─────────────────────────────────────────────────
 * Resolving the subject. A garage prospect is a Prospect with an email and a recorded consent; a
 * garage on trial is a Group with a billing address; a waiting affiliate is an AffiliateWaitlist row;
 * a new affiliate is a Rep. So there is exactly one per-audience function — readSubject — and
 * everything else in this file is shared. Four adapters and one engine, rather than four engines.
 *
 * readSubject answers two questions at once, and that is on purpose: the address to write to, and
 * whether this enrolment should STOP NOW. They are asked together because they are read from the
 * same row at the same moment, and asking separately is how a sequence sends one more email to
 * somebody who paid yesterday.
 */
import type { Prisma, PrismaClient } from '@prisma/client';
import { randomBytes } from 'crypto';
import { prisma } from '@/lib/db';
import { sendNotification, PLATFORM_SEND } from '@/lib/notify';
import { emailHash } from '@/lib/prospect-keys';
import { normaliseEmail, refuseEnrolment } from '@/lib/prospects';
import {
  CONSENT_OF, GOAL_STOP, SEQUENCE_KEYS, STEPS, SUBJECT_OF, afterDaysForStep, afterSend,
  copyIsSendable, ctaOf, isSequenceKey, sendingAllows,
  type ConsentSource, type CopyRow, type SequenceKey, type StopReason,
} from '@/lib/marketing-engine';

type Tx = Prisma.TransactionClient;
type Db = PrismaClient;

/** The template each sequence sends through. One per sequence; the words are rows, not templates. */
const TEMPLATE_OF: Record<SequenceKey, string> = {
  garage_prospect: 'marketing_garage_prospect',
  trial_garage: 'marketing_trial_garage',
  affiliate_interest: 'marketing_affiliate_interest',
  affiliate_new: 'marketing_affiliate_new',
};

// ══ THE SWITCHES ═════════════════════════════════════════════════════════════════════════════════
/**
 * IS THIS SEQUENCE SENDING? NO ROW = OFF, which is the default and the state each one ships in.
 * Read on every run and every render, never cached: a switch that took an hour to take effect would
 * be a switch that did not work at the moment somebody needed it to.
 */
export async function sendingEnabled(
  sequence: SequenceKey, db: Db = prisma, at: { now?: Date; enrolmentId?: string } = {},
): Promise<boolean> {
  const [owner, lease] = await Promise.all([
    db.marketingSending.findUnique({ where: { sequence_key: sequence }, select: { enabled: true } }),
    // Asked without an enrolment (a cron run, a whole sequence), no lease can apply — see sendingAllows.
    at.enrolmentId ? db.marketingSendingLease.findUnique({ where: { enrolment_id: at.enrolmentId } }) : null,
  ]);
  return sendingAllows(owner, lease, { now: at.now ?? new Date(), enrolmentId: at.enrolmentId });
}

export type SwitchState = {
  sequence: SequenceKey; enabled: boolean;
  changedAt: Date | null; changedBy: string | null;
  /** Active enrolments waiting on this switch. The number the owner is deciding about. */
  queued: number;
  /** Steps 1..5 that have sendable copy. A sequence cannot usefully be switched on without them. */
  copyWritten: number;
};

/** Every switch, with what turning it on would actually set in motion. A gate never writes these. */
export async function allSwitchStates(db: Db = prisma): Promise<SwitchState[]> {
  const [rows, queued, copy] = await Promise.all([
    db.marketingSending.findMany(),
    db.marketingEnrolment.groupBy({ by: ['sequence_key'], where: { state: 'active' }, _count: { _all: true } }),
    db.marketingCopy.findMany({ select: { sequence_key: true, step: true, subject: true, body: true } }),
  ]);
  return SEQUENCE_KEYS.map((sequence) => {
    const row = rows.find((r) => r.sequence_key === sequence) ?? null;
    return {
      sequence,
      enabled: sendingAllows(row, null, { now: new Date() }),
      changedAt: row?.changed_at ?? null,
      changedBy: row?.changed_by ?? null,
      queued: queued.find((q) => q.sequence_key === sequence)?._count._all ?? 0,
      copyWritten: copy.filter((c) => c.sequence_key === sequence && copyIsSendable(c)).length,
    };
  });
}

/**
 * TURN ONE SEQUENCE ON OR OFF — owner only (enforced by the caller's guard), and AUDITED. Turning
 * one on emails real people, so who did it, when, and how many enrolments it released goes to
 * SuperAdminAudit as well as onto the row.
 *
 * The count is taken INSIDE the transaction and recorded, because "I switched it on" and "I switched
 * it on and 340 emails went out" are different events and only the second one is the truth.
 */
export async function setSending(opts: { sequence: SequenceKey; enabled: boolean; operatorId: string; db?: Db }): Promise<void> {
  const db = opts.db ?? prisma;
  const now = new Date();
  await db.$transaction(async (tx) => {
    const before = await tx.marketingSending.findUnique({ where: { sequence_key: opts.sequence }, select: { enabled: true } });
    await tx.marketingSending.upsert({
      where: { sequence_key: opts.sequence },
      update: { enabled: opts.enabled, changed_at: now, changed_by: opts.operatorId },
      create: { sequence_key: opts.sequence, enabled: opts.enabled, changed_at: now, changed_by: opts.operatorId },
    });
    const released = await tx.marketingEnrolment.count({ where: { sequence_key: opts.sequence, state: 'active' } });
    await tx.superAdminAudit.create({ data: {
      operator_user_id: opts.operatorId,
      action: opts.enabled ? 'marketing_sending.on' : 'marketing_sending.off',
      target_name_snapshot: `Marketing sequence — ${opts.sequence}`,
      detail: { sequence: opts.sequence, from: before?.enabled === true, to: opts.enabled, activeEnrolmentsAtChange: released },
    } });
  });
}

// ══ THE COPY ═════════════════════════════════════════════════════════════════════════════════════
export type CopyStep = {
  sequence: SequenceKey; step: number;
  subject: string; body: string; ctaLabel: string | null; ctaUrl: string | null;
  updatedAt: Date | null; updatedBy: string | null;
  /** The runner's own verdict, from the same pure function, so the screen cannot promise more. */
  sendable: boolean;
  /** Days after the previous email this one goes. Step 1 is 0 — it does not wait for the cron. */
  afterDays: number;
};

/** Every step of one sequence, written or not. An unwritten step is a row with blanks, never absent. */
export async function copyFor(sequence: SequenceKey, db: Db = prisma): Promise<CopyStep[]> {
  const rows = await db.marketingCopy.findMany({ where: { sequence_key: sequence } });
  return Array.from({ length: STEPS }, (_, i) => {
    const step = i + 1;
    const r = rows.find((x) => x.step === step) ?? null;
    return {
      sequence, step,
      subject: r?.subject ?? '', body: r?.body ?? '',
      ctaLabel: r?.cta_label ?? null, ctaUrl: r?.cta_url ?? null,
      updatedAt: r?.updated_at ?? null, updatedBy: r?.updated_by ?? null,
      sendable: copyIsSendable(r),
      afterDays: afterDaysForStep(step),
    };
  });
}

export type SaveCopyResult = { ok: true } | { ok: false; message: string };

/**
 * WRITE ONE STEP. Latest wins — there is no draft axis, deliberately (see the model comment): the
 * sequences ship off, an edit is read on the next run, and a second state is a second thing to be
 * wrong about.
 *
 * A BLANK SAVE IS ALLOWED and is not a no-op: it is how a step is taken back out of service, and the
 * runner then HOLDS at it rather than sending an empty email or skipping ahead.
 */
export async function saveCopy(opts: {
  sequence: SequenceKey; step: number; subject: string; body: string;
  ctaLabel?: string | null; ctaUrl?: string | null; operatorId: string; db?: Db;
}): Promise<SaveCopyResult> {
  const db = opts.db ?? prisma;
  const { ctaUrlAllowed } = await import('@/lib/marketing-engine');
  const label = String(opts.ctaLabel ?? '').trim();
  const url = String(opts.ctaUrl ?? '').trim();
  // BOTH OR NEITHER, said here as a sentence rather than left to MarketingCopy_cta_chk's 500. The
  // database holds the rule; this is so somebody typing gets told which half is missing.
  if (label && !url) return { ok: false, message: 'The button needs a link as well as a label.' };
  if (url && !label) return { ok: false, message: 'The button needs a label as well as a link.' };
  if (url && !ctaUrlAllowed(url)) {
    return { ok: false, message: 'The button link must be a full web address starting http:// or https://.' };
  }
  const data = {
    subject: String(opts.subject ?? ''), body: String(opts.body ?? ''),
    cta_label: label || null, cta_url: url || null, updated_by: opts.operatorId,
  };
  await db.marketingCopy.upsert({
    where: { sequence_key_step: { sequence_key: opts.sequence, step: opts.step } },
    update: data,
    create: { sequence_key: opts.sequence, step: opts.step, ...data },
  });
  return { ok: true };
}

/**
 * WHAT ONE STEP WOULD ACTUALLY LOOK LIKE — rendered through the real template, not a second
 * renderer written beside it. A preview produced by its own code agrees with itself and proves
 * nothing (independent-oracle-finds-copies); this one goes wrong in exactly the ways a real send
 * would, which is the only kind of preview worth having.
 *
 * The unsubscribe link is a visible placeholder rather than a real token: a preview must show that
 * the way out is there, and must not mint a working one that an operator could click and suppress a
 * real address with.
 */
export async function previewStep(sequence: SequenceKey, step: number, db: Db = prisma):
  Promise<{ ok: true; subject: string; html: string } | { ok: false; message: string }> {
  const row = await db.marketingCopy.findUnique({ where: { sequence_key_step: { sequence_key: sequence, step } } });
  if (!copyIsSendable(row)) return { ok: false, message: 'Nothing written for this email yet.' };
  const { NOTIFICATION_TEMPLATES } = await import('@/lib/notification-templates');
  const tpl = (NOTIFICATION_TEMPLATES as Record<string, { email?: (d: Record<string, unknown>) => { subject: string; html: string } }>)[TEMPLATE_OF[sequence]];
  if (!tpl?.email) return { ok: false, message: 'That sequence has no email renderer.' };
  const cta = ctaOf(row);
  const out = tpl.email({
    subject: row!.subject, body: row!.body,
    ctaLabel: cta?.label ?? null, ctaUrl: cta?.url ?? null,
    consentSource: CONSENT_OF[sequence],
    unsubscribeUrl: '#preview-unsubscribe-link',
  });
  return { ok: true, subject: out.subject, html: out.html };
}

/**
 * SEND ONE STEP TO ONE ADDRESS, NOW, AS A TEST.
 *
 * It goes through sendNotification like any other send, so it is logged, it respects the unsubscribe
 * list, and it leaves from the marketing domain — a test that takes a shortcut past all three tests
 * nothing worth testing. It deliberately does NOT consult the sequence's switch: the whole point is
 * to read the email before turning the sequence on.
 *
 * NO ENROLMENT IS CREATED and nothing is advanced. The recipient is whoever the operator typed,
 * which in practice is themselves — and because the address may well be a GreaseDesk user's, the
 * `already_customer` refusal would block a test of the garage-prospect sequence. That refusal is
 * reported back as what it is rather than dressed up as a failure.
 */
export async function sendTest(opts: { sequence: SequenceKey; step: number; to: string; operatorId: string; db?: Db }):
  Promise<{ ok: true } | { ok: false; message: string }> {
  const db = opts.db ?? prisma;
  const to = normaliseEmail(opts.to);
  if (!to) return { ok: false, message: 'Type an address to send the test to.' };
  const row = await db.marketingCopy.findUnique({ where: { sequence_key_step: { sequence_key: opts.sequence, step: opts.step } } });
  if (!copyIsSendable(row)) return { ok: false, message: 'Nothing written for this email yet.' };
  const cta = ctaOf(row);
  // A REAL TOKEN, FOR A REAL ENROLMENT THAT DOES NOT EXIST. The link must be clickable in the test
  // so the operator can check it reads right; it resolves to nothing, so clicking it suppresses
  // nobody and the endpoint's 404 is the correct answer.
  const token = `test-${randomBytes(12).toString('base64url')}`;
  const r = await sendNotification({
    recipient: to,
    template: TEMPLATE_OF[opts.sequence] as never,
    groupId: PLATFORM_SEND,
    data: {
      subject: row!.subject, body: row!.body,
      ctaLabel: cta?.label ?? null, ctaUrl: cta?.url ?? null,
      consentSource: CONSENT_OF[opts.sequence],
      unsubscribeUrl: unsubscribeLinks(token).page,
    },
    emailOpts: { headers: unsubscribeHeaders(token) },
  });
  if (r.ok) return { ok: true };
  return { ok: false, message: `Not sent — ${r.reason ?? r.status}.` };
}

// ══ THE WAY OUT ══════════════════════════════════════════════════════════════════════════════════
/** Where the unsubscribe page and endpoint live — the apex, which middleware serves to anyone. */
export function unsubscribeLinks(token: string, base?: string) {
  const origin = (base || process.env.NEXT_PUBLIC_APP_URL || process.env.NEXTAUTH_URL || 'https://greasedesk.com').replace(/\/$/, '');
  return {
    /** The link in the body: a page with a button. Mail scanners follow links, so opening it must not act. */
    page: `${origin}/u/${token}`,
    /** RFC 8058 one-click: a mail client POSTs `List-Unsubscribe=One-Click` here, showing nothing. */
    oneClick: `${origin}/api/marketing-unsubscribe?t=${encodeURIComponent(token)}`,
  };
}

const unsubscribeHeaders = (token: string, base?: string) => ({
  'List-Unsubscribe': `<${unsubscribeLinks(token, base).oneClick}>`,
  'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
});

/** 16 random bytes, base64url — 22 characters, the shape the prospect token had. */
const newToken = (): string => randomBytes(16).toString('base64url');

/**
 * ONE CLICK, AND NO MORE MARKETING EMAIL FROM GREASEDESK — all four sequences, not just the one the
 * link came from (owner, 2026-11-02). An unsubscribe is a statement about the sender.
 *
 * Three things happen, and the order matters:
 *   1. the ADDRESS goes on the suppression list, so nothing can be sent to it again even after the
 *      address itself has been removed from wherever it was stored;
 *   2. the enrolment that sent the link stops, so the request visibly did something;
 *   3. every OTHER enrolment reachable from that address stops too — found by looking the address up
 *      in each of the four subject tables, because the enrolment holds no copy of it.
 *
 * Step 3 is not redundant with step 1. Suppression refuses the send, so an unstopped enrolment would
 * come to the same thing in the end — but it would keep reading `running` on the Engine Room screen
 * until its next step came due, and a screen that says an unsubscribed person is being emailed is
 * worse than no screen.
 *
 * Idempotent: a second click says it is already done rather than failing.
 */
export async function unsubscribeByToken(token: string, now: Date = new Date(), db: Db = prisma):
  Promise<{ ok: true; already: boolean; stopped: number } | { ok: false; code: 'not_found' }> {
  const e = await db.marketingEnrolment.findUnique({
    where: { unsubscribe_token: token },
    select: { id: true, sequence_key: true, subject_type: true, subject_id: true, state: true },
  });
  if (!e) return { ok: false, code: 'not_found' };
  const already = e.state === 'stopped';

  const seq = e.sequence_key as SequenceKey;
  const read = await readSubject(seq, e.subject_id, db);
  const address = read.ok ? read.email : null;

  if (address) {
    await db.prospectSuppression.upsert({
      where: { email_hash: emailHash(address) }, update: {},
      create: { email_hash: emailHash(address), reason: 'unsubscribed' },
    });
  }
  // The clicked one first, so the request is never the one that changed nothing.
  await db.$transaction((tx) => stopOne(tx, e.id, 'unsubscribed', now));
  let stopped = 1;
  if (address) stopped += await stopEverythingFor(address, now, db, e.id);

  // THE PERSON'S DATA GOES TOO, where the audience holds any. A prospect's email and the named
  // person at every visit are removed by the one writer that does that (lib/prospect-store), on the
  // same trigger it always had. The other three audiences hold an address and nothing else, and the
  // address is what the suppression hash exists to outlive.
  if (seq === 'garage_prospect') {
    const { stripPersonal } = await import('@/lib/prospect-store');
    await db.$transaction((tx) => stripPersonal(tx, e.subject_id, 'unsubscribed', now));
  }
  return { ok: true, already, stopped };
}

/**
 * EVERY ACTIVE ENROLMENT THIS ADDRESS IS ON, STOPPED. Looks the address up in each subject table,
 * because the enrolment deliberately holds no copy of it.
 *
 * The lookups are per-table and not clever: four small queries on indexed email columns, run when
 * somebody unsubscribes. A join through a polymorphic column would be the clever version and would
 * also be the one that silently misses a table when a fifth audience arrives — these fail loudly,
 * because adding an audience without adding its line here leaves a gap a gate can see.
 */
async function stopEverythingFor(address: string, now: Date, db: Db, exceptId?: string): Promise<number> {
  const to = normaliseEmail(address);
  if (!to) return 0;
  const [prospects, waitlist, reps, groups] = await Promise.all([
    db.prospect.findMany({ where: { email: to }, select: { id: true } }),
    db.affiliateWaitlist.findMany({ where: { email: to }, select: { id: true } }),
    db.rep.findMany({ where: { email: { equals: to, mode: 'insensitive' } }, select: { id: true } }),
    db.group.findMany({ where: { billing_email: { equals: to, mode: 'insensitive' } }, select: { id: true } }),
  ]);
  const subjects: Array<{ sequence: SequenceKey; id: string }> = [
    ...prospects.map((r) => ({ sequence: 'garage_prospect' as SequenceKey, id: r.id })),
    ...waitlist.map((r) => ({ sequence: 'affiliate_interest' as SequenceKey, id: r.id })),
    ...reps.map((r) => ({ sequence: 'affiliate_new' as SequenceKey, id: r.id })),
    ...groups.map((r) => ({ sequence: 'trial_garage' as SequenceKey, id: r.id })),
  ];
  if (!subjects.length) return 0;
  const rows = await db.marketingEnrolment.findMany({
    where: {
      state: 'active',
      ...(exceptId ? { id: { not: exceptId } } : {}),
      OR: subjects.map((s) => ({ sequence_key: s.sequence, subject_type: SUBJECT_OF[s.sequence], subject_id: s.id })),
    },
    select: { id: true },
  });
  let n = 0;
  for (const r of rows) {
    if (await db.$transaction((tx) => stopOne(tx, r.id, 'unsubscribed', now))) n += 1;
  }
  return n;
}

// ══ STOPPING ═════════════════════════════════════════════════════════════════════════════════════
/**
 * CONDITIONAL ON THE PRE-STATE, so stopping an already-stopped enrolment changes nothing and cannot
 * overwrite the FIRST reason with a later one — "unsubscribed" must never become "not_eligible".
 * Carried over from lib/prospect-store::stopSequence, where the same sentence is the comment.
 */
export async function stopOne(tx: Tx, enrolmentId: string, reason: StopReason, now: Date): Promise<boolean> {
  const r = await tx.marketingEnrolment.updateMany({
    where: { id: enrolmentId, state: 'active' },
    data: { state: 'stopped', stopped_at: now, stopped_reason: reason, next_due_at: null },
  });
  return r.count === 1;
}

/** Stop by subject — what a goal event (a payment, a referral, a signup) calls. */
export async function stopFor(sequence: SequenceKey, subjectId: string, reason: StopReason, now: Date = new Date(), db: Db = prisma): Promise<boolean> {
  const e = await db.marketingEnrolment.findUnique({
    where: { sequence_key_subject_type_subject_id: { sequence_key: sequence, subject_type: SUBJECT_OF[sequence], subject_id: subjectId } },
    select: { id: true },
  });
  if (!e) return false;
  return db.$transaction((tx) => stopOne(tx, e.id, reason, now));
}

// ══ ENROLLING ════════════════════════════════════════════════════════════════════════════════════
export type EnrolResult =
  | { ok: true; enrolmentId: string; state: 'active' | 'stopped'; stoppedReason: StopReason | null }
  | { ok: false; code: 'already_enrolled' | 'not_eligible' | 'no_address' | 'bad_sequence' };

/**
 * ENROL, OR RECORD WHY NOT. An address that has already unsubscribed still gets an enrolment row —
 * STOPPED, with the reason — so the log shows the email was deliberately never sent rather than
 * being silently absent. Carried over from lib/prospect-store::enrol, which had the same paragraph.
 *
 * consentAt is the caller's to supply, and it is the moment the person actually agreed — the rep's
 * recorded answer, the signup, the waiting-list form, the terms acceptance. NOT `now`: an enrolment
 * created today for somebody who agreed in August must say August, or the one piece of evidence this
 * row exists to carry is a date we made up.
 */
export async function enrol(opts: {
  sequence: SequenceKey; subjectId: string; consentAt: Date; now?: Date; db?: Db;
}): Promise<EnrolResult> {
  const db = opts.db ?? prisma;
  const now = opts.now ?? new Date();
  if (!isSequenceKey(opts.sequence)) return { ok: false, code: 'bad_sequence' };

  const existing = await db.marketingEnrolment.findUnique({
    where: { sequence_key_subject_type_subject_id: { sequence_key: opts.sequence, subject_type: SUBJECT_OF[opts.sequence], subject_id: opts.subjectId } },
    select: { id: true },
  });
  if (existing) return { ok: false, code: 'already_enrolled' };

  const read = await readSubject(opts.sequence, opts.subjectId, db);
  if (!read.ok) return { ok: false, code: read.stop === 'subject_gone' ? 'not_eligible' : 'not_eligible' };
  if (!read.email) return { ok: false, code: 'no_address' };

  // ASKED AT ENROLMENT AS WELL AS AT SEND. The send asks again, live, and that is the guard that
  // matters — but an enrolment created already-stopped is a record that says we knew, and an
  // enrolment list full of rows that will never send is a list nobody reads.
  const { marketingRefusal } = await import('@/lib/marketing-suppression');
  const refusal = await marketingRefusal(read.email, opts.sequence);
  const stopped: StopReason | null = refusal === 'already_customer' ? 'already_customer'
    : refusal === 'platform_unsubscribed' ? 'suppressed' : null;

  const row = await db.marketingEnrolment.create({
    data: {
      sequence_key: opts.sequence, subject_type: SUBJECT_OF[opts.sequence], subject_id: opts.subjectId,
      consent_source: CONSENT_OF[opts.sequence] as ConsentSource, consent_at: opts.consentAt,
      started_at: now, next_step: 1,
      ...(stopped
        ? { state: 'stopped', stopped_at: now, stopped_reason: stopped }
        : { state: 'active', next_due_at: now }),
    },
    select: { id: true },
  });
  return { ok: true, enrolmentId: row.id, state: stopped ? 'stopped' : 'active', stoppedReason: stopped };
}

// ══ THE FOUR ADAPTERS ════════════════════════════════════════════════════════════════════════════
export type SubjectRead =
  | { ok: true; email: string | null; data: Record<string, string> }
  | { ok: false; stop: StopReason };

/**
 * THE ADDRESS, AND WHETHER TO STOP — read from the subject's own row, at the moment of use.
 *
 * ── WHY THE GOAL IS CHECKED HERE AND NOT ONLY ON THE EVENT ─────────────────────────────────────
 * Every goal has an event that could stop the sequence the moment it happens: a paid invoice, a new
 * attribution, a signup. Those hooks exist and are the fast path. This is the SLOW path, asked again
 * on every single send, and it is the one that is actually load-bearing — because a hook that was
 * not wired, was wired to one of two code paths, or threw, leaves an enrolment running, and the
 * consequence is an email telling somebody to start a trial they started last week.
 *
 * A guard whose premise is "the hook will have fired" is a guard that outlives its hazard.
 */
export async function readSubject(sequence: SequenceKey, subjectId: string, db: Db = prisma): Promise<SubjectRead> {
  switch (sequence) {
    case 'garage_prospect': {
      const p = await db.prospect.findUnique({
        where: { id: subjectId },
        select: { email: true, consent: true, personal_stripped_at: true, status: true, garage_name: true },
      });
      if (!p) return { ok: false, stop: 'subject_gone' };
      // The existing pure predicate, unchanged, so prospect eligibility has one definition.
      const refusal = refuseEnrolment(p);
      if (refusal === 'signed_up') return { ok: false, stop: 'signed_up' };
      if (refusal === 'stripped') return { ok: false, stop: 'retention' };
      // no_consent: they were asked again and declined, or the answer was withdrawn. `suppressed` is
      // the reason lib/prospect-store used for it and it is kept so the two eras count together.
      if (refusal === 'no_consent') return { ok: false, stop: 'suppressed' };
      return { ok: true, email: p.email, data: { name: p.garage_name, garageName: p.garage_name } };
    }

    case 'trial_garage': {
      const g = await db.group.findUnique({
        where: { id: subjectId },
        select: { billing_email: true, group_name: true, is_demo: true, is_internal: true, billing: { select: { subscription_status: true, first_paid_at: true } } },
      });
      if (!g) return { ok: false, stop: 'subject_gone' };
      // A DEMO OR INTERNAL TENANT IS NOT A PROSPECT TO NURTURE, and this is the only sequence where
      // that could happen: the other three audiences have no tenant behind them. Checked LIVE rather
      // than only at enrolment, because the flags are set and unset by hand and the sales demo
      // deliberately has is_demo FALSE so it can text — so this cannot lean on the demo block inside
      // sendNotification, which a PLATFORM send never reaches anyway (it has no group to check).
      if (g.is_demo || g.is_internal) return { ok: false, stop: 'not_eligible' };
      if (g.billing?.first_paid_at) return { ok: false, stop: 'first_payment' };
      // Left the trial by some other door — cancelled, lapsed, never completed Checkout. Not the
      // goal and not a disappearance: they are simply no longer the audience.
      if (g.billing?.subscription_status !== 'trialing') return { ok: false, stop: 'not_eligible' };
      return { ok: true, email: g.billing_email, data: { name: g.group_name ?? 'there', garageName: g.group_name ?? 'your garage' } };
    }

    case 'affiliate_interest': {
      const w = await db.affiliateWaitlist.findUnique({ where: { id: subjectId }, select: { email: true } });
      if (!w) return { ok: false, stop: 'subject_gone' };
      // JOINED = a Rep exists with that address. The waiting list is deliberately not a signup and
      // holds no link to the Rep it may become, so the address is the only join there is.
      const joined = await db.rep.findFirst({ where: { email: { equals: w.email, mode: 'insensitive' } }, select: { id: true } });
      if (joined) return { ok: false, stop: 'joined' };
      return { ok: true, email: w.email, data: { name: 'there' } };
    }

    case 'affiliate_new': {
      const r = await db.rep.findUnique({
        where: { id: subjectId },
        select: { email: true, name: true, party_type: true, suspended_at: true, ref_code: true },
      });
      if (!r) return { ok: false, stop: 'subject_gone' };
      if (r.party_type !== 'affiliate') return { ok: false, stop: 'not_eligible' };
      // A suspended affiliate is not being encouraged to refer: suspension stops NEW attribution, so
      // the thing these emails ask for is the thing they are currently barred from.
      if (r.suspended_at) return { ok: false, stop: 'not_eligible' };
      const referred = await db.tenantAttribution.findFirst({
        where: { party_type: 'affiliate', party_id: subjectId }, select: { id: true },
      });
      if (referred) return { ok: false, stop: 'first_referral' };
      return { ok: true, email: r.email, data: { name: r.name, refCode: r.ref_code } };
    }
  }
}

// ══ THE RUNNER ═══════════════════════════════════════════════════════════════════════════════════
export type SequenceRun = {
  sequence: SequenceKey;
  /** THE SWITCH, IN THE RUN'S OWN OUTPUT — so a run that sent nothing says why rather than looking idle. */
  sending: 'on' | 'off';
  /** Enrolments due now that were NOT sent because the sequence is off. Zero whenever it is on. */
  queued: number;
  considered: number;
  sent: number;
  /** Due, switched on, and HELD because nobody has written that step. Named, never silently idle. */
  heldNoCopy: number;
  /** Due and switched on, but the subject has no address to write to. A third silence, not a failure. */
  noAddress: number;
  stopped: Array<{ enrolmentId: string; reason: StopReason }>;
  retrying: number;
};

/**
 * SEND EVERY DUE STEP, ACROSS EVERY SEQUENCE OR ONE.
 *
 * CLAIMED BEFORE IT IS SENT, by a conditional update on the pre-state, so two overlapping runs
 * cannot both send one step — the second finds next_due_at already moved and matches nothing. The
 * claim is a 15-minute lease on the row, and a step that fails to send has it put straight back.
 */
export async function runSequences(opts: {
  now?: Date; onlySequence?: SequenceKey; onlyEnrolmentId?: string; db?: Db; base?: string;
} = {}): Promise<SequenceRun[]> {
  const now = opts.now ?? new Date();
  const db = opts.db ?? prisma;
  const sequences = opts.onlySequence ? [opts.onlySequence] : [...SEQUENCE_KEYS];
  const out: SequenceRun[] = [];

  for (const sequence of sequences) {
    const run: SequenceRun = { sequence, sending: 'on', queued: 0, considered: 0, sent: 0, heldNoCopy: 0, noAddress: 0, stopped: [], retrying: 0 };
    out.push(run);
    const scope = {
      sequence_key: sequence, state: 'active', next_due_at: { lte: now },
      ...(opts.onlyEnrolmentId ? { id: opts.onlyEnrolmentId } : {}),
    } as const;

    // ── THE SWITCH STOPS THE SEND, NEVER THE ENROLMENT ────────────────────────────────────────
    // Off: nothing is claimed, advanced or stopped. Every due enrolment stays exactly as it is —
    // queued — and starts at the step it is on (step 1 for anyone enrolled while off) on the first
    // run after the switch goes on. The run REPORTS that it held them, so an empty run is never
    // mistaken for a run with nothing to do.
    //
    // Measured on the WALL clock, not the run's `now`: `now` is the sequence's clock (a caller may
    // pass a later one to make a step due), and a lease's five minutes are real minutes.
    if (!(await sendingEnabled(sequence, db, { enrolmentId: opts.onlyEnrolmentId }))) {
      run.sending = 'off';
      run.queued = await db.marketingEnrolment.count({ where: scope });
      continue;
    }

    const copy = await db.marketingCopy.findMany({ where: { sequence_key: sequence } });
    const due = await db.marketingEnrolment.findMany({
      where: scope,
      select: { id: true, subject_id: true, next_step: true, next_due_at: true, unsubscribe_token: true, consent_source: true },
      take: 200,
    });

    for (const e of due) {
      run.considered += 1;
      const lease = new Date(now.getTime() + 15 * 60_000);
      const claimed = await db.marketingEnrolment.updateMany({
        where: { id: e.id, state: 'active', next_step: e.next_step, next_due_at: e.next_due_at },
        data: { next_due_at: lease },
      });
      if (claimed.count !== 1) continue;

      const stop = async (reason: StopReason) => {
        await db.$transaction((tx) => stopOne(tx, e.id, reason, now));
        run.stopped.push({ enrolmentId: e.id, reason });
      };
      // PUT THE CLAIM BACK. A step that did not go must stay due, never be skipped as if it had.
      const retry = async () => {
        await db.marketingEnrolment.updateMany({ where: { id: e.id, state: 'active' }, data: { next_due_at: now } });
      };

      // RE-ASKED AT SEND TIME: they may have paid, joined, referred, signed up or been stripped
      // since the step came due — including since the last line of this very loop.
      const read = await readSubject(sequence, e.subject_id, db);
      if (!read.ok) { await stop(read.stop); continue; }
      if (!read.email) { run.noAddress += 1; await retry(); continue; }

      if (e.next_step > STEPS) { await stop('completed'); continue; }
      const step = copy.find((c) => c.step === e.next_step) ?? null;
      if (!copyIsSendable(step)) { run.heldNoCopy += 1; await retry(); continue; }

      // Minted on first use and kept, so every email in one person's sequence carries the same link.
      let token = e.unsubscribe_token;
      if (!token) {
        token = newToken();
        await db.marketingEnrolment.update({ where: { id: e.id }, data: { unsubscribe_token: token } });
      }
      const cta = ctaOf(step as CopyRow);
      const r = await sendNotification({
        recipient: read.email,
        template: TEMPLATE_OF[sequence] as never,
        groupId: PLATFORM_SEND,
        subject: { type: 'marketing_enrolment', id: e.id },
        data: {
          ...read.data,
          subject: step!.subject, body: step!.body,
          ctaLabel: cta?.label ?? null, ctaUrl: cta?.url ?? null,
          consentSource: e.consent_source,
          unsubscribeUrl: unsubscribeLinks(token, opts.base).page,
        },
        emailOpts: { headers: unsubscribeHeaders(token, opts.base) },
      });

      if (r.ok) {
        const next = afterSend(e.next_step, now);
        if (next.state === 'active') {
          await db.marketingEnrolment.update({ where: { id: e.id }, data: { next_step: next.next_step, next_due_at: next.next_due_at, last_sent_at: now } });
        } else {
          await db.marketingEnrolment.update({ where: { id: e.id }, data: { last_sent_at: now } });
          await stop('completed');
        }
        run.sent += 1;
      } else if (r.skipCode === 'already_customer') {
        await stop('already_customer');
      } else if (r.skipCode === 'platform_unsubscribed') {
        await stop('suppressed');
      } else {
        // NOT SENT FOR A REASON THAT MAY PASS — no provider, a provider refusal, a failed check.
        await retry();
        run.retrying += 1;
      }
    }
  }
  return out;
}

/**
 * THE ENROLMENTS FOR A LIST OF SUBJECTS, keyed by subject id — what an audience's own screen needs.
 *
 * Here rather than in each screen because MarketingEnrolment has no relation to its subject, so the
 * join is a second query that every list has to remember to make. Two screens hand-rolling it is two
 * chances to forget the sequence_key and show one audience's enrolment on another's row.
 */
export async function enrolmentsFor(
  sequence: SequenceKey, subjectIds: string[], db: Db = prisma,
): Promise<Map<string, { id: string; state: string; stopped_reason: string | null; last_sent_at: Date | null; next_step: number }>> {
  if (!subjectIds.length) return new Map();
  const rows = await db.marketingEnrolment.findMany({
    where: { sequence_key: sequence, subject_type: SUBJECT_OF[sequence], subject_id: { in: subjectIds } },
    select: { id: true, subject_id: true, state: true, stopped_reason: true, last_sent_at: true, next_step: true },
  });
  return new Map(rows.map((r) => [r.subject_id, r]));
}

/** The goal stop for a sequence, by name, for the hooks that fire on the event itself. */
export const goalStopFor = (sequence: SequenceKey): StopReason => GOAL_STOP[sequence];
