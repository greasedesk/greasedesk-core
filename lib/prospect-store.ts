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
import {
  isProspectStatus, looksLikeEmail, nameKey,
  normaliseEmail, pastRetention, postcodeKey, refuseEnrolment,
  type ProspectStatus, type StripReason,
} from '@/lib/prospects';
import { enrolmentState, type SequenceState, type StopReason } from '@/lib/marketing-engine';
import { enrol, runSequences, sendingEnabled, stopFor } from '@/lib/marketing-store';

type Tx = Prisma.TransactionClient;
type Db = PrismaClient;

// ── THE SEQUENCE IS NOT THIS FILE'S ANY MORE (2026-11-02) ────────────────────────────────────────
// The switch, the links, the sender and the enrolment moved to lib/marketing-store when three more
// audiences arrived. A garage prospect is now one of four things that can be enrolled on a sequence,
// and this file is one of four adapters — lib/marketing-store::readSubject reads a Prospect through
// refuseEnrolment, which stays in lib/prospects so prospect eligibility has a single definition.
//
// WHAT STAYED: recording a visit, presenting a possible duplicate, the 24-month retention sweep, and
// stripPersonal — the ONE writer that removes a named person and their email. That last one is why
// MarketingEnrolment deliberately holds no address of its own: a second copy of a prospect's email
// in a table this function does not reach would make the retention rule a rule nobody applies.

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

/**
 * STOP THIS PROSPECT'S SEQUENCE. Delegates to the engine, which holds the conditional-on-pre-state
 * update that stops an already-stopped enrolment from having its FIRST reason overwritten by a later
 * one — "unsubscribed" must not become "retention".
 *
 * NOT inside the caller's transaction, and that is a real change from the version this replaces.
 * stripPersonal ran its stop in the same transaction as the columns it cleared; the enrolment now
 * lives in a table with no relation to Prospect, so the two writes are separate. The consequence if
 * the second fails: the person's data is gone and an enrolment is left active — which the next send
 * stops anyway, because readSubject reads `personal_stripped_at` and returns `retention`. The guard
 * that matters is the one on the send path, not the one in the transaction.
 */
async function stopProspectSequence(prospectId: string, reason: StopReason, now: Date): Promise<boolean> {
  return stopFor('garage_prospect', prospectId, reason, now);
}

export async function stripPersonal(tx: Tx, prospectId: string, reason: StripReason, now: Date): Promise<void> {
  await stopProspectSequence(prospectId, STOP_FOR_STRIP[reason], now);
  await tx.prospectVisit.updateMany({ where: { prospect_id: prospectId }, data: { spoke_to: null } });
  // Only a record still holding the person is stripped; the FIRST reason stands.
  await tx.prospect.updateMany({
    where: { id: prospectId, personal_stripped_at: null },
    data: { email: null, personal_stripped_at: now, personal_stripped_reason: reason },
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
      view: SequenceState; sendingOn: boolean }
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

    if (status === 'signed_up') await stripPersonal(tx, id, 'signed_up', now);
    return id;
  });

  // ── THE ENROLMENT IS CREATED OUTSIDE THE TRANSACTION, AND IT HAS TO BE ────────────────────────
  // MarketingEnrolment lives in a table with no relation to Prospect, and enrolling asks the
  // suppression list — a query the visit's transaction has no business holding a row lock through.
  // The ordering is deliberate: the VISIT commits first, and the enrolment is the thing allowed to
  // fail. A recorded visit with no follow-up is a rep's work saved; a follow-up with no visit is a
  // record of an email nobody can explain. Commit the record, then the consequence.
  if (status !== 'signed_up') {
    const after = await db.prospect.findUniqueOrThrow({
      where: { id: prospectId },
      select: { email: true, consent: true, consent_at: true, personal_stripped_at: true, status: true },
    });
    // CONSENT_AT, NOT NOW. The owner agreed at the moment the rep recorded their answer, which may
    // have been a previous visit — a visit today where nobody asked again leaves the earlier `agreed`
    // standing, and an enrolment stamped today would be claiming consent we did not get today.
    if (!refuseEnrolment(after) && after.consent_at) {
      await enrol({ sequence: 'garage_prospect', subjectId: prospectId, consentAt: after.consent_at, now, db }).catch(() => {});
    }
  }

  // THE FIRST EMAIL GOES NOW, not at the next scheduled run — "it must work from the moment the
  // address is entered". Awaited but never fatal: the visit is recorded whether or not the send
  // works, and an unsent step stays due for the scheduled run to retry.
  const e = await db.marketingEnrolment.findUnique({
    where: { sequence_key_subject_type_subject_id: { sequence_key: 'garage_prospect', subject_type: 'prospect', subject_id: prospectId } },
    select: { id: true },
  });
  if (e) await runSequences({ now, onlySequence: 'garage_prospect', onlyEnrolmentId: e.id, db }).catch(() => {});

  const seq = e ? await db.marketingEnrolment.findUnique({
    where: { id: e.id }, select: { state: true, stopped_reason: true, last_sent_at: true, next_step: true },
  }) : null;
  const sendingOn = await sendingEnabled('garage_prospect', db, { enrolmentId: e?.id });
  // hasCopy IS ASKED, because `holding` is a state the rep must be able to read. Without it a visit
  // recorded while step 1 is unwritten would say "the first email will go within the hour", and it
  // will not go until somebody writes it.
  const hasCopy = seq ? await stepHasCopy(db, seq.next_step) : true;
  return { ok: true, prospectId, sequence: seq ? { state: seq.state, stoppedReason: seq.stopped_reason } : null,
    view: enrolmentState(seq, { sendingOn, hasCopy }), sendingOn };
}

/** Is the words for this step written? The same predicate the runner uses, so the two agree. */
async function stepHasCopy(db: Db, step: number): Promise<boolean> {
  const { copyIsSendable } = await import('@/lib/marketing-engine');
  const row = await db.marketingCopy.findUnique({ where: { sequence_key_step: { sequence_key: 'garage_prospect', step } } });
  return copyIsSendable(row);
}

// ── SIGNUP ───────────────────────────────────────────────────────────────────────────────────────
/**
 * A NEW TENANT'S ADDRESS MATCHED AGAINST EVERY PROSPECT HOLDING IT. Called from register-garage.
 * The send path refuses a customer's address regardless (lib/marketing-suppression), so this is not
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
