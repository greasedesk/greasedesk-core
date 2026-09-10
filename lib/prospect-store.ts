/**
 * File: lib/prospect-store.ts
 * EVERY WRITE TO A PROSPECT, IN ONE PLACE — recording a visit, enrolling, stopping, unsubscribing,
 * signing up, and stripping the person's data. Server-only; the rules it applies are lib/prospects.
 *
 * ── THE THREE WAYS A SEQUENCE ENDS, AND EACH SAYS SO ────────────────────────────────────────────
 * A sequence never disappears. It stops, and the row records when and why — ProspectSequence_stop_chk
 * refuses a stop with no reason. "Stopped" without "why" is a log that tells the next reader nothing.
 *
 * ── THE PERSON GOES; THE GROUND COVERED STAYS ───────────────────────────────────────────────────
 * stripPersonal is the ONE function that removes a named person and their email. It runs on three
 * triggers: 24 months after the last visit (sweepRetention), immediately on unsubscribe, and on
 * signup. The garage, the visit dates and the notes about the business are never touched by it.
 *
 * SIGNUP IS A THIRD TRIGGER, added beyond the brief's two, and deliberately: once the prospect is a
 * customer, their contact lives on the tenant record and the prospecting copy is redundant — and it is
 * the one copy a later tenant ERASURE could not reach (Prospect holds the tenant's id, not a relation,
 * so a purge never sees it). Stripping at signup means an erasure request leaves nothing behind here.
 */
import type { Prisma, PrismaClient } from '@prisma/client';
import { prisma } from '@/lib/db';
import { sendNotification, PLATFORM_SEND } from '@/lib/notify';
import { prospectingRefusal } from '@/lib/prospect-suppression';
import { emailHash, newUnsubscribeToken } from '@/lib/prospect-keys';
import {
  SEQUENCE, afterSend, isProspectStatus, looksLikeEmail, nameKey,
  normaliseEmail, pastRetention, postcodeKey, refuseEnrolment, sequenceView, sendingAllows,
  type ProspectStatus, type SequenceView, type StopReason, type StripReason,
} from '@/lib/prospects';

type Tx = Prisma.TransactionClient;
type Db = PrismaClient;

// ── THE SENDING SWITCH ───────────────────────────────────────────────────────────────────────────
const SWITCH_ID = 'prospect_sending';

/**
 * IS PROSPECT SENDING ON? No row = OFF — the default, because the sequence copy is placeholder until
 * the owner writes it. Read on every run and every render that shows a follow-up, never cached: a
 * switch that took an hour to take effect would be a switch that did not work when it mattered.
 */
export async function prospectSendingEnabled(db: Db = prisma, at: { now?: Date; prospectId?: string } = {}): Promise<boolean> {
  const [owner, lease] = await Promise.all([
    db.prospectSending.findUnique({ where: { id: SWITCH_ID }, select: { enabled: true } }),
    // Asked without a prospect (a cron run, a list of many), no lease can apply — see sendingAllows.
    at.prospectId ? db.prospectSendingLease.findUnique({ where: { prospect_id: at.prospectId } }) : null,
  ]);
  return sendingAllows(owner, lease, { now: at.now ?? new Date(), prospectId: at.prospectId });
}

/** The OWNER'S switch and its author, for the Engine Room. `changedAt` NULL = never switched. A gate never writes it. */
export async function prospectSendingState(db: Db = prisma) {
  const row = await db.prospectSending.findUnique({ where: { id: SWITCH_ID } });
  return { enabled: sendingAllows(row, null, { now: new Date() }), changedAt: row?.changed_at ?? null, changedBy: row?.changed_by ?? null };
}

/**
 * TURN IT ON OR OFF — owner only (enforced by the caller's guard), and AUDITED. Turning it on emails
 * real people, so who did it and when goes to SuperAdminAudit as well as onto the row.
 */
export async function setProspectSending(opts: { enabled: boolean; operatorId: string; db?: Db }): Promise<void> {
  const db = opts.db ?? prisma;
  const now = new Date();
  await db.$transaction(async (tx) => {
    const before = await tx.prospectSending.findUnique({ where: { id: SWITCH_ID }, select: { enabled: true } });
    await tx.prospectSending.upsert({
      where: { id: SWITCH_ID },
      update: { enabled: opts.enabled, changed_at: now, changed_by: opts.operatorId },
      create: { id: SWITCH_ID, enabled: opts.enabled, changed_at: now, changed_by: opts.operatorId },
    });
    const queued = await tx.prospectSequence.count({ where: { state: 'active' } });
    await tx.superAdminAudit.create({ data: {
      operator_user_id: opts.operatorId,
      action: opts.enabled ? 'prospect_sending.on' : 'prospect_sending.off',
      target_name_snapshot: 'Prospect follow-up sending',
      detail: { from: before?.enabled === true, to: opts.enabled, activeSequencesAtChange: queued },
    } });
  });
}

/** Where the unsubscribe page and endpoint live — the apex, which middleware serves to anyone. */
export function prospectLinks(token: string, base?: string) {
  const origin = (base || process.env.NEXT_PUBLIC_APP_URL || process.env.NEXTAUTH_URL || 'https://greasedesk.com').replace(/\/$/, '');
  return {
    /** The link in the email body: a page with a button. Mail scanners follow links, so opening it must not act. */
    page: `${origin}/u/${token}`,
    /** RFC 8058 one-click: a mail client POSTs `List-Unsubscribe=One-Click` here without opening anything. */
    oneClick: `${origin}/api/prospect-unsubscribe?t=${encodeURIComponent(token)}`,
  };
}

// ── DUPLICATES — presented, never merged ─────────────────────────────────────────────────────────
/**
 * GARAGES THAT MIGHT BE THIS ONE. Same normalised name, and a postcode that matches or is missing on
 * either side — leaning towards presenting too many rather than too few: a false candidate costs the
 * rep one tap to reject, a missed one splits a garage's history in two, which is the failure this
 * record exists to prevent. The rep decides; nothing here merges.
 *
 * Garage-level fields only. Another rep's record may hold a named person and an email, and a rep
 * checking for a duplicate has no need to see either.
 */
export async function findMatches(name: string, postcode: string | null, db: Db = prisma) {
  const nk = nameKey(name);
  if (!nk) return [];
  const pk = postcodeKey(postcode);
  const rows = await db.prospect.findMany({
    where: { name_key: nk, ...(pk ? { OR: [{ postcode_key: pk }, { postcode_key: null }] } : {}) },
    select: {
      id: true, garage_name: true, postcode: true, address_line1: true, status: true,
      visits: { orderBy: { visited_on: 'desc' }, take: 1, select: { visited_on: true } },
      _count: { select: { visits: true } },
    },
    take: 5,
  });
  return rows.map((r) => ({
    id: r.id, garageName: r.garage_name, postcode: r.postcode, addressLine1: r.address_line1, status: r.status,
    lastVisit: r.visits[0]?.visited_on.toISOString() ?? null, visitCount: r._count.visits,
  }));
}

// ── THE ONE WAY THE PERSON LEAVES ────────────────────────────────────────────────────────────────
const STOP_FOR_STRIP: Record<StripReason, StopReason> = { unsubscribed: 'unsubscribed', signed_up: 'signed_up', retention: 'retention' };

export async function stopSequence(tx: Tx, prospectId: string, reason: StopReason, now: Date): Promise<boolean> {
  // CONDITIONAL ON THE PRE-STATE: stopping an already-stopped sequence changes nothing and must not
  // overwrite the FIRST reason with a later one — "unsubscribed" must not become "retention".
  const r = await tx.prospectSequence.updateMany({
    where: { prospect_id: prospectId, state: 'active' },
    data: { state: 'stopped', stopped_at: now, stopped_reason: reason, next_due_at: null },
  });
  return r.count === 1;
}

export async function stripPersonal(tx: Tx, prospectId: string, reason: StripReason, now: Date): Promise<void> {
  await stopSequence(tx, prospectId, STOP_FOR_STRIP[reason], now);
  await tx.prospectVisit.updateMany({ where: { prospect_id: prospectId }, data: { spoke_to: null } });
  // Only a record still holding the person is stripped; the FIRST reason stands.
  await tx.prospect.updateMany({
    where: { id: prospectId, personal_stripped_at: null },
    data: { email: null, personal_stripped_at: now, personal_stripped_reason: reason },
  });
}

// ── ENROLMENT ────────────────────────────────────────────────────────────────────────────────────
/**
 * ENROL, OR RECORD WHY NOT. An address that is already a customer's, or already unsubscribed, still
 * gets a sequence row — STOPPED, with the reason — so the log shows the email was deliberately never
 * sent rather than silently absent.
 */
async function enrol(tx: Tx, prospect: { id: string; email: string }, now: Date) {
  const existing = await tx.prospectSequence.findUnique({ where: { prospect_id: prospect.id }, select: { id: true } });
  if (existing) return;
  await tx.prospect.updateMany({ where: { id: prospect.id, unsubscribe_token: null }, data: { unsubscribe_token: newUnsubscribeToken() } });
  const refusal = await prospectingRefusal(prospect.email);
  const stopped: StopReason | null = refusal === 'already_customer' ? 'already_customer'
    : refusal === 'prospect_unsubscribed' ? 'suppressed' : null;
  await tx.prospectSequence.create({
    data: stopped
      ? { prospect_id: prospect.id, state: 'stopped', next_step: 1, started_at: now, stopped_at: now, stopped_reason: stopped }
      : { prospect_id: prospect.id, state: 'active', next_step: 1, next_due_at: now, started_at: now },
  });
}

// ── RECORDING A VISIT — what the rep does on the forecourt ───────────────────────────────────────
export type RecordVisitInput = {
  repId: string;
  /** An existing prospect the rep CONFIRMED is this garage. Absent = a new garage. */
  prospectId?: string | null;
  garage?: { name: string; addressLine1?: string | null; locality?: string | null; postcode?: string | null };
  visit: { visitedOn: Date; spokeTo?: string | null; note?: string | null; status: string };
  email?: string | null;
  /** true = they ASKED and the owner AGREED; false = asked, declined; null/absent = not asked. */
  consent?: boolean | null;
  now?: Date;
};
export type RecordVisitResult =
  | { ok: true; prospectId: string; sequence: { state: string; stoppedReason: string | null } | null;
      /** What the follow-up is ACTUALLY doing — queued is never reported as running. */
      view: SequenceView; sendingOn: boolean }
  | { ok: false; code: string; message: string };

const clean = (v: unknown): string | null => { const s = String(v ?? '').trim(); return s === '' ? null : s; };

export async function recordVisit(input: RecordVisitInput, db: Db = prisma): Promise<RecordVisitResult> {
  const now = input.now ?? new Date();
  const status = input.visit.status;
  if (!isProspectStatus(status)) return { ok: false, code: 'bad_status', message: 'Pick how the visit went.' };
  const email = normaliseEmail(input.email);
  if (email && !looksLikeEmail(email)) return { ok: false, code: 'bad_email', message: 'That email address does not look complete.' };
  // CONSENT WITHOUT AN ADDRESS IS REFUSED, not stored as a dangling yes. The database refuses it too
  // (Prospect_no_email_no_consent_chk); saying it here gives the rep a sentence instead of a 500.
  if (input.consent != null && !email) {
    return { ok: false, code: 'consent_without_email', message: 'Add the email address they agreed to, or leave the question unanswered.' };
  }
  if (!input.prospectId && !clean(input.garage?.name)) return { ok: false, code: 'no_name', message: 'The garage needs a name.' };

  const prospectId = await db.$transaction(async (tx) => {
    let id = input.prospectId ?? null;
    if (id) {
      const found = await tx.prospect.findUnique({ where: { id }, select: { id: true } });
      if (!found) throw new Error('PROSPECT_NOT_FOUND');
    } else {
      const g = input.garage!;
      const created = await tx.prospect.create({
        data: {
          garage_name: clean(g.name)!, name_key: nameKey(g.name),
          address_line1: clean(g.addressLine1), address_locality: clean(g.locality),
          postcode: clean(g.postcode)?.toUpperCase() ?? null, postcode_key: postcodeKey(g.postcode),
          status, created_by_rep_id: input.repId,
        },
        select: { id: true },
      });
      id = created.id;
    }

    await tx.prospectVisit.create({
      data: { prospect_id: id, rep_id: input.repId, visited_on: input.visit.visitedOn,
        spoke_to: clean(input.visit.spokeTo), note: clean(input.visit.note), status_at_visit: status },
    });

    const p = await tx.prospect.findUniqueOrThrow({ where: { id }, select: { email: true, consent: true, personal_stripped_at: true, status: true } });
    const data: Prisma.ProspectUpdateInput = { status: status as ProspectStatus };
    // A NEW ANSWER ONLY WHEN THIS VISIT GAVE ONE. A previous "agreed" is not erased by a visit where
    // nobody asked again — silence is not a withdrawal.
    if (email && !p.personal_stripped_at) {
      data.email = email;
      if (input.consent === true) Object.assign(data, { consent: 'agreed', consent_at: now, consent_by_rep_id: input.repId });
      if (input.consent === false) Object.assign(data, { consent: 'declined', consent_at: now, consent_by_rep_id: input.repId });
    }
    if (status === 'signed_up') Object.assign(data, { signed_up_at: now });
    await tx.prospect.update({ where: { id }, data });

    if (status === 'signed_up') {
      await stripPersonal(tx, id, 'signed_up', now);
    } else {
      const after = await tx.prospect.findUniqueOrThrow({ where: { id }, select: { id: true, email: true, consent: true, personal_stripped_at: true, status: true } });
      if (!refuseEnrolment(after)) await enrol(tx, { id, email: after.email! }, now);
    }
    return id;
  });

  // THE FIRST EMAIL GOES NOW, not at the next scheduled run — "it must work from the moment the
  // address is entered". Awaited but never fatal: the visit is recorded whether or not the send works,
  // and an unsent step stays due for the scheduled run to retry.
  await runSequence({ now, onlyProspectId: prospectId, db }).catch(() => {});

  const seq = await db.prospectSequence.findUnique({ where: { prospect_id: prospectId }, select: { state: true, stopped_reason: true, last_sent_at: true } });
  const sendingOn = await prospectSendingEnabled(db, { prospectId });
  return { ok: true, prospectId, sequence: seq ? { state: seq.state, stoppedReason: seq.stopped_reason } : null,
    view: sequenceView(seq, sendingOn), sendingOn };
}

// ── UNSUBSCRIBE ──────────────────────────────────────────────────────────────────────────────────
/**
 * STOPS IMMEDIATELY, visibly, and removes the person — keeping only the hash needed to go on
 * honouring it. Idempotent: a second click says it is already done rather than failing.
 */
export async function unsubscribeByToken(token: string, now: Date = new Date(), db: Db = prisma):
  Promise<{ ok: true; already: boolean } | { ok: false; code: 'not_found' }> {
  const p = await db.prospect.findUnique({ where: { unsubscribe_token: token }, select: { id: true, email: true, personal_stripped_at: true } });
  if (!p) return { ok: false, code: 'not_found' };
  const already = p.personal_stripped_at !== null && !p.email;
  await db.$transaction(async (tx) => {
    if (p.email) {
      await tx.prospectSuppression.upsert({
        where: { email_hash: emailHash(p.email) }, update: {},
        create: { email_hash: emailHash(p.email), reason: 'unsubscribed' },
      });
    }
    await stripPersonal(tx, p.id, 'unsubscribed', now);
    // A record ALREADY stripped for another reason still has its sequence stopped here, so an
    // unsubscribe is never the one request that changes nothing.
    await stopSequence(tx, p.id, 'unsubscribed', now);
  });
  return { ok: true, already };
}

// ── SIGNUP ───────────────────────────────────────────────────────────────────────────────────────
/**
 * A NEW TENANT'S ADDRESS MATCHED AGAINST EVERY PROSPECT HOLDING IT. Called from register-garage.
 * The send path refuses a customer's address regardless (lib/prospect-suppression), so this is not
 * the only guard — it is what makes the LOG say "signed up" rather than "already a customer".
 */
export async function markSignedUpByEmail(email: string, groupId: string, now: Date = new Date(), db: Db = prisma): Promise<number> {
  const to = normaliseEmail(email);
  if (!to) return 0;
  const hits = await db.prospect.findMany({ where: { email: to, personal_stripped_at: null }, select: { id: true } });
  for (const h of hits) {
    await db.$transaction(async (tx) => {
      await tx.prospect.update({ where: { id: h.id }, data: { status: 'signed_up', signed_up_at: now, signed_up_group_id: groupId } });
      await stripPersonal(tx, h.id, 'signed_up', now);
    });
  }
  return hits.length;
}

// ── THE SENDER ───────────────────────────────────────────────────────────────────────────────────
export type SequenceRun = {
  /** THE SWITCH, IN THE RUN'S OWN OUTPUT — so a run that sent nothing says why, rather than looking idle. */
  sending: 'on' | 'off';
  /** Sequences due now that were NOT sent because sending is off. Zero whenever sending is on. */
  queued: number;
  considered: number; sent: number; stopped: Array<{ prospectId: string; reason: StopReason }>; retrying: number;
};

/**
 * SEND EVERY DUE STEP. Called by the scheduled job, and once straight after a visit is recorded.
 *
 * CLAIMED BEFORE IT IS SENT, by a conditional update on the pre-state, so two overlapping runs cannot
 * both send one step — the second finds next_due_at already moved and matches nothing.
 */
export async function runSequence(opts: { now?: Date; onlyProspectId?: string; db?: Db; base?: string } = {}): Promise<SequenceRun> {
  const now = opts.now ?? new Date();
  const db = opts.db ?? prisma;
  const out: SequenceRun = { sending: 'on', queued: 0, considered: 0, sent: 0, stopped: [], retrying: 0 };

  // ── THE SWITCH STOPS THE SEND, NEVER THE ENROLMENT ──────────────────────────────────────────
  // Off: nothing is claimed, nothing advanced, nothing stopped. Every due sequence stays exactly as it
  // is — queued — and starts at the step it is on (step 1 for anyone enrolled while off) the first run
  // after the switch goes on. The run REPORTS that it held them, so an empty run is never mistaken for
  // a run with nothing to do.
  // The lease is measured on the WALL clock, not the run's `now`: `now` is the sequence's clock (a
  // caller may pass a later one to make a step due), and a lease's five minutes are real minutes.
  if (!(await prospectSendingEnabled(db, { prospectId: opts.onlyProspectId }))) {
    out.sending = 'off';
    out.queued = await db.prospectSequence.count({
      where: { state: 'active', next_due_at: { lte: now }, ...(opts.onlyProspectId ? { prospect_id: opts.onlyProspectId } : {}) },
    });
    return out;
  }
  const due = await db.prospectSequence.findMany({
    where: { state: 'active', next_due_at: { lte: now }, ...(opts.onlyProspectId ? { prospect_id: opts.onlyProspectId } : {}) },
    select: { id: true, prospect_id: true, next_step: true, next_due_at: true,
      prospect: { select: { email: true, consent: true, personal_stripped_at: true, status: true, garage_name: true, unsubscribe_token: true } } },
    take: 200,
  });

  for (const s of due) {
    out.considered++;
    const lease = new Date(now.getTime() + 15 * 60_000);
    const claimed = await db.prospectSequence.updateMany({
      where: { id: s.id, state: 'active', next_step: s.next_step, next_due_at: s.next_due_at },
      data: { next_due_at: lease },
    });
    if (claimed.count !== 1) continue;

    const stop = async (reason: StopReason) => {
      await db.$transaction((tx) => stopSequence(tx, s.prospect_id, reason, now));
      out.stopped.push({ prospectId: s.prospect_id, reason });
    };

    // RE-ASKED AT SEND TIME: the prospect may have signed up, been stripped or withdrawn since.
    const refusal = refuseEnrolment(s.prospect);
    if (refusal) { await stop(refusal === 'signed_up' ? 'signed_up' : refusal === 'stripped' ? 'retention' : 'suppressed'); continue; }
    const step = SEQUENCE.find((x) => x.step === s.next_step);
    if (!step) { await stop('completed'); continue; }

    const links = prospectLinks(s.prospect.unsubscribe_token ?? '', opts.base);
    const r = await sendNotification({
      recipient: s.prospect.email!, template: step.template, groupId: PLATFORM_SEND,
      subject: { type: 'prospect', id: s.prospect_id },
      data: { garageName: s.prospect.garage_name, unsubscribeUrl: links.page },
      emailOpts: { headers: { 'List-Unsubscribe': `<${links.oneClick}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' } },
    });

    if (r.ok) {
      const next = afterSend(s.next_step, now);
      if (next.state === 'active') {
        await db.prospectSequence.update({ where: { id: s.id }, data: { next_step: next.next_step, next_due_at: next.next_due_at, last_sent_at: now } });
      } else {
        await db.prospectSequence.update({ where: { id: s.id }, data: { last_sent_at: now } });
        await stop('completed');
      }
      out.sent++;
    } else if (r.skipCode === 'already_customer') {
      await stop('already_customer');
    } else if (r.skipCode === 'prospect_unsubscribed') {
      await stop('suppressed');
    } else {
      // NOT SENT FOR A REASON THAT MAY PASS — no provider, a provider refusal, a failed check. The
      // step stays due and the lease expires, so the next run tries again. Never advanced: a step
      // that did not go must not be skipped as if it had.
      await db.prospectSequence.updateMany({ where: { id: s.id, state: 'active' }, data: { next_due_at: now } });
      out.retrying++;
    }
  }
  return out;
}

// ── RETENTION ────────────────────────────────────────────────────────────────────────────────────
/**
 * THE 24-MONTH RULE, IMPLEMENTED. Built before anything is old enough to trigger it, because a
 * retention rule with no implementation is a policy nobody applies. Measured from the LAST visit.
 */
export async function sweepRetention(now: Date = new Date(), db: Db = prisma): Promise<number> {
  const rows = await db.prospect.findMany({
    where: { personal_stripped_at: null },
    select: { id: true, visits: { orderBy: { visited_on: 'desc' }, take: 1, select: { visited_on: true } } },
  });
  let n = 0;
  for (const r of rows) {
    const last = r.visits[0]?.visited_on;
    if (last && pastRetention(last, now)) {
      await db.$transaction((tx) => stripPersonal(tx, r.id, 'retention', now));
      n++;
    }
  }
  return n;
}
