/**
 * File: lib/payee-admin.ts
 * THE OWNER'S SIDE OF A PAYEE REQUEST: read it, apply it, reject it, reveal it.
 *
 * ── APPLYING DOES NOT DECRYPT ANYTHING, AND THAT IS THE BEST PROPERTY HERE ──────────────────────
 * The ciphertext is COPIED from the request onto the Rep row. The owner approves a payee without
 * the digits ever being rendered, without the key being touched, and without an audit row claiming
 * a reveal that did not happen. Revealing is a separate, deliberate act with its own button and its
 * own audit row — which is what makes "every reveal is audited" true rather than aspirational: the
 * ordinary path never reveals, so the audit log contains only real reveals.
 *
 * ── WHAT THE OWNER IS SHOWN INSTEAD ─────────────────────────────────────────────────────────────
 * The last four, the account name, and — for a nominee — the people at the garages this affiliate
 * introduced, printed beside it. lib/payee can refuse an exact email match and says in its own
 * header why it will not compare names; this is the half of the control that is a person looking at
 * two lists, so the screen has to actually put them next to each other.
 */
import type { PrismaClient } from '@prisma/client';
import { prisma as defaultDb } from '@/lib/db';
import { decryptPayee, payeeDigits, PayeeCipherError, PayeeKeyError } from '@/lib/payee-crypto';
import { payeeKeyRefusal } from '@/lib/payee-key-check';
import { formatSortCode, maskedForOwner, refuseAccountName } from '@/lib/payee';
/**
 * STATICALLY, like every other caller of it. A dynamic `await import('@/lib/notify')` lost
 * PLATFORM_SEND's identity — it typed as a plain `symbol` against a `unique symbol` parameter and
 * would not compile, which is the type system saying what the sentinel is FOR: a declared platform
 * scope that cannot be reached by accident. No cycle: notify does not reach this file.
 */
import { sendNotification, PLATFORM_SEND } from '@/lib/notify';

type Db = PrismaClient;

export type ReferredPerson = { name: string | null; email: string; garage: string };

export type PayeeRequestRow = {
  id: string;
  affiliateId: string;
  affiliateName: string;
  refCode: string;
  payeeKind: string;
  accountName: string;
  /** ••••1234 — the owner's mask, four digits, because they are checking it against a bank screen. */
  masked: string;
  nomineeEmail: string | null;
  requestedAt: Date;
  /** The people at the garages this affiliate introduced. Printed beside a nominee, not filtered by. */
  referredPeople: ReferredPerson[];
  /** What we hold for them today, so the owner can see whether this is a change or a first set. */
  currentMasked: string | null;
};

/** Every PENDING request, newest first. Applied, rejected and superseded rows are history. */
export async function listPayeeRequests(db: Db = defaultDb as Db): Promise<PayeeRequestRow[]> {
  const rows = await db.repPayeeRequest.findMany({
    where: { status: 'pending' },
    orderBy: { requested_at: 'desc' },
    // NO sort_code_enc, NO account_number_enc. A list is not a reveal, and a column not selected
    // cannot reach a screen by accident.
    select: {
      id: true, rep_id: true, payee_kind: true, account_name: true, account_last4: true,
      nominee_email: true, requested_at: true,
      rep: { select: { name: true, ref_code: true, bank_account_last4: true } },
    },
  });
  if (rows.length === 0) return [];

  const repIds = [...new Set(rows.map((r) => r.rep_id))];
  const terms = await db.tenantAffiliateTerms.findMany({
    where: { affiliate_id: { in: repIds } },
    select: { affiliate_id: true, group_id: true },
  });
  const groupIds = [...new Set(terms.map((t) => t.group_id))];
  const people = groupIds.length
    ? await db.user.findMany({
      where: { group_id: { in: groupIds } },
      select: { name: true, email: true, group_id: true, group: { select: { group_name: true } } },
      take: 200,
    })
    : [];

  return rows.map((r) => {
    const mine = new Set(terms.filter((t) => t.affiliate_id === r.rep_id).map((t) => t.group_id));
    return {
      id: r.id,
      affiliateId: r.rep_id,
      affiliateName: r.rep.name,
      refCode: r.rep.ref_code,
      payeeKind: r.payee_kind,
      accountName: r.account_name,
      masked: maskedForOwner(r.account_last4),
      nomineeEmail: r.nominee_email,
      requestedAt: r.requested_at,
      referredPeople: people
        .filter((p) => p.group_id && mine.has(p.group_id))
        .map((p) => ({ name: p.name, email: p.email, garage: p.group?.group_name ?? '(not named yet)' })),
      currentMasked: r.rep.bank_account_last4 ? maskedForOwner(r.rep.bank_account_last4) : null,
    };
  });
}

export type Decision = { ok: true } | { ok: false; code: string; message: string };

/**
 * APPLY. The ciphertext moves across unopened; the request becomes 'applied'; both in one
 * transaction, because a Rep row carrying new details beside a request still saying 'pending' is a
 * state the approval screen would offer to apply a second time.
 *
 * ALL FOUR COLUMNS TOGETHER. Rep_bank_chk makes the three all-or-none at the database; the fourth,
 * bank_account_last4, is outside that CHECK deliberately (a CHECK on an existing table reaches a
 * deployed writer) and is held in step by this being the only writer. payee-gate asserts no row
 * carries a last4 without the three.
 */
export async function applyPayeeRequest(
  db: Db,
  args: { requestId: string; operatorUserId: string },
): Promise<Decision> {
  const req = await db.repPayeeRequest.findUnique({
    where: { id: args.requestId },
    select: {
      id: true, rep_id: true, status: true, account_name: true, account_last4: true,
      sort_code_enc: true, account_number_enc: true, payee_kind: true,
    },
  });
  if (!req) return { ok: false, code: 'not_found', message: 'That request no longer exists.' };
  if (req.status !== 'pending') {
    // NAMES THE STATE IT IS IN. "Already decided" sends somebody looking for a bug; "it was
    // superseded by a later request" tells them what happened and what to do.
    return { ok: false, code: 'not_pending', message: `That request is ${req.status}, so there is nothing to apply.` };
  }

  await db.$transaction(async (tx) => {
    await tx.rep.update({
      where: { id: req.rep_id },
      data: {
        bank_account_name: req.account_name,
        bank_sort_code: req.sort_code_enc,
        bank_account_number: req.account_number_enc,
        bank_account_last4: req.account_last4,
      },
    });
    await tx.repPayeeRequest.update({
      where: { id: req.id },
      data: { status: 'applied', decided_at: new Date(), decided_by: args.operatorUserId },
    });
  });

  await auditRep(db, {
    operatorUserId: args.operatorUserId,
    repId: req.rep_id,
    action: 'rep.payee_applied',
    nameSnapshot: req.account_name,
    refSnapshot: `${req.payee_kind} · account ending ${req.account_last4}`,
    detail: { request_id: req.id, payee_kind: req.payee_kind, last4: req.account_last4 },
  });
  return { ok: true };
}

/**
 * ── CORRECT THE ACCOUNT NAME, AND NOTHING ELSE (owner, 2026-11-01) ──────────────────────────────
 * A name can be typed wrong — a middle initial, a trading name, an "and" where the bank holds "&" —
 * and a transfer bounces on it. Today the only way to fix one is to make the affiliate submit their
 * whole payee again, which asks them to retype two credential-grade numbers to correct a word.
 *
 * ── IT CANNOT REACH THE DIGITS, BY CONSTRUCTION ─────────────────────────────────────────────────
 * The update names ONE column. There is no sort code or account number in the argument, so no
 * caller can pass one, and no later edit of a shared object can smuggle one through — which is why
 * this does not take a partial payee and route it through applyPayeeRequest's writer. The gate reads
 * the ciphertext back byte-for-byte after a correction.
 *
 * It also never decrypts. Correcting a name is not a reveal and must not write one.
 *
 * ── TWO SUBJECTS, SAID RATHER THAN GUESSED ──────────────────────────────────────────────────────
 * `held` is the name on the Rep row — what a payment run would print. `request` is the name on a
 * PENDING request, corrected before it is applied. They are different facts about different rows,
 * and an owner looking at the screen is looking at one or the other, so the caller names which.
 *
 * An APPLIED request is deliberately not correctable: that row is the record of what was asked for,
 * and rewriting it would edit history to fix the present. The held name is the present.
 *
 * ── THE AFFILIATE IS TOLD, AND THE WRITE DOES NOT WAIT ON THE TELLING ───────────────────────────
 * Somebody else changing where their money goes is exactly what they should hear about — and the
 * one-line defence against this being the attack it looks like. But the correction is committed
 * BEFORE the send, and a send that fails does not undo it: the standing rule here is the money
 * first, then the secondary guard. What happened to the email is REPORTED back, in the three states
 * a send has, because "we told them" and "we could not" are different things for the owner to know.
 */
export type NameCorrection = Decision & { emailed?: 'sent' | 'not_sent'; emailNote?: string };

export async function correctPayeeName(
  db: Db,
  args: {
    subject: { kind: 'held'; repId: string } | { kind: 'request'; requestId: string };
    newName: string;
    operatorUserId: string;
  },
): Promise<NameCorrection> {
  const refusal = refuseAccountName(args.newName);
  if (refusal) return { ok: false, code: 'bad_name', message: refusal };
  const newName = String(args.newName).trim();

  /** The row, its current name, and who it belongs to — resolved for either subject. */
  let repId: string;
  let before: string | null;
  let last4: string | null;
  if (args.subject.kind === 'request') {
    const req = await db.repPayeeRequest.findUnique({
      where: { id: args.subject.requestId },
      select: { id: true, rep_id: true, status: true, account_name: true, account_last4: true },
    });
    if (!req) return { ok: false, code: 'not_found', message: 'That request no longer exists.' };
    if (req.status !== 'pending') {
      return {
        ok: false,
        code: 'not_pending',
        message: `That request is ${req.status}. An applied request is the record of what was asked for — `
          + 'correct the name we hold instead.',
      };
    }
    repId = req.rep_id; before = req.account_name; last4 = req.account_last4;
  } else {
    const rep = await db.rep.findUnique({
      where: { id: args.subject.repId },
      select: { id: true, party_type: true, bank_account_name: true, bank_account_last4: true },
    });
    if (!rep || rep.party_type !== 'affiliate') return { ok: false, code: 'not_found', message: 'No such affiliate.' };
    // NO HELD DETAILS IS NOT A NAME TO CORRECT. Writing one would leave a name beside no account —
    // the state Rep_bank_chk exists to make impossible from the other three columns.
    if (!rep.bank_account_last4) {
      return { ok: false, code: 'nothing_held', message: 'We hold no bank details for them, so there is no name to correct.' };
    }
    repId = rep.id; before = rep.bank_account_name; last4 = rep.bank_account_last4;
  }

  // A NO-OP IS REFUSED rather than audited. An audit row saying a name was changed from X to X is a
  // record of an act that did not happen, and the owner reading it later cannot tell.
  if ((before ?? '').trim() === newName) {
    return { ok: false, code: 'unchanged', message: 'That is the name we already hold.' };
  }

  if (args.subject.kind === 'request') {
    await db.repPayeeRequest.update({ where: { id: args.subject.requestId }, data: { account_name: newName } });
  } else {
    // ONE COLUMN. Named here, where a reader can see that the digits are not in it.
    await db.rep.update({ where: { id: repId }, data: { bank_account_name: newName } });
  }

  // BOTH VALUES, which is the whole point of the row: "the name was corrected" without the old one
  // cannot answer the question somebody will actually ask, which is what it used to say.
  await auditRep(db, {
    operatorUserId: args.operatorUserId,
    repId,
    action: 'rep.payee_name_corrected',
    nameSnapshot: newName,
    refSnapshot: `name corrected · account ending ${last4 ?? '????'}`,
    detail: { subject: args.subject.kind, from: before, to: newName, last4 },
  });

  const told = await tellAffiliateTheNameChanged(db, { repId, newName });
  return { ok: true, ...told };
}

/**
 * THE EMAIL. Its own function so the failure modes are visible: no address on the row, the send
 * refused by policy, and the provider rejecting it are three different outcomes, and the owner's
 * screen says which — an affiliate who was NOT told is the case that needs a phone call.
 */
async function tellAffiliateTheNameChanged(
  db: Db,
  args: { repId: string; newName: string },
): Promise<{ emailed: 'sent' | 'not_sent'; emailNote?: string }> {
  try {
    const rep = await db.rep.findUnique({ where: { id: args.repId }, select: { email: true, name: true } });
    if (!rep?.email) return { emailed: 'not_sent', emailNote: 'we hold no email address for them' };
    const sent = await sendNotification({
      recipient: rep.email,
      template: 'affiliate_payee_name_corrected',
      channel: 'email',
      // GREASEDESK WRITING TO SOMEBODY WHO IS NOT A CUSTOMER — stated, never inferred from an absent
      // tenant, which would silently disable the demo block and the opt-out check.
      groupId: PLATFORM_SEND,
      subject: { type: 'rep', id: args.repId },
      data: { accountName: args.newName, name: rep.name },
    });
    if (sent.ok) return { emailed: 'sent' };
    return { emailed: 'not_sent', emailNote: sent.reason ?? sent.status };
  } catch (e) {
    // THE CORRECTION STANDS. The send is the secondary act and a throw here must not look like a
    // failed correction — it is logged loudly and reported as "not sent", which is the truth.
    console.error('[payee-admin] name corrected but the affiliate could not be told for', args.repId, e);
    return { emailed: 'not_sent', emailNote: 'the message could not be sent' };
  }
}

/** REJECT. A reason is required: a refusal somebody cannot explain is one they will be asked about. */
export async function rejectPayeeRequest(
  db: Db,
  args: { requestId: string; operatorUserId: string; reason: string },
): Promise<Decision> {
  const reason = String(args.reason ?? '').trim();
  if (reason.length < 3) return { ok: false, code: 'no_reason', message: 'Say why, so it can be explained later.' };

  const req = await db.repPayeeRequest.findUnique({
    where: { id: args.requestId },
    select: { id: true, rep_id: true, status: true, account_last4: true },
  });
  if (!req) return { ok: false, code: 'not_found', message: 'That request no longer exists.' };
  if (req.status !== 'pending') return { ok: false, code: 'not_pending', message: `That request is ${req.status}.` };

  await db.repPayeeRequest.update({
    where: { id: req.id },
    data: { status: 'rejected', decided_at: new Date(), decided_by: args.operatorUserId, reject_reason: reason },
  });
  await auditRep(db, {
    operatorUserId: args.operatorUserId,
    repId: req.rep_id,
    action: 'rep.payee_rejected',
    nameSnapshot: reason,
    refSnapshot: `rejected · account ending ${req.account_last4}`,
    detail: { request_id: req.id, reason },
  });
  return { ok: true };
}

export type Revealed = { accountName: string | null; sortCode: string; accountNumber: string };

/**
 * ── REVEAL. THE ONLY PLACE DIGITS ARE PRODUCED, AND IT WRITES A ROW EVERY TIME ──────────────────
 * Not "every time something changed" — every time. The audit question here is "who looked", and a
 * reveal that produced the same digits as yesterday's is still somebody looking.
 *
 * THE AUDIT IS WRITTEN BEFORE THE VALUE IS RETURNED, and a failed write FAILS THE REVEAL. That is
 * the opposite of how the suspension writer treats its audit, and deliberately: suspension must
 * stand even if the record is lost, because leaving somebody earning is worse. Here the value has
 * not left the server yet, and an unlogged reveal is precisely the thing the control exists to
 * prevent — so this one refuses rather than proceeds.
 */
export async function revealPayee(
  db: Db,
  args: { repId: string; operatorUserId: string },
): Promise<{ ok: true; value: Revealed } | { ok: false; code: string; message: string }> {
  const rep = await db.rep.findUnique({
    where: { id: args.repId },
    select: { id: true, name: true, ref_code: true, bank_account_name: true, bank_sort_code: true, bank_account_number: true, bank_account_last4: true },
  });
  if (!rep) return { ok: false, code: 'not_found', message: 'No such affiliate.' };
  if (!rep.bank_sort_code || !rep.bank_account_number) {
    // THREE STATES: we hold none is not a failure to read, and must not be reported as one.
    return { ok: false, code: 'none_held', message: 'We hold no bank details for them.' };
  }

  /**
   * THE KEY MUST BELONG TO THIS DATABASE — checked before the audit row is written, so a reveal that
   * cannot succeed does not leave a record saying somebody looked. With the wrong key the decrypt
   * below would throw PayeeCipherError and the operator would be told the row was damaged; this says
   * the true thing instead, which is that the environment holds the wrong key.
   */
  const keyRefusal = await payeeKeyRefusal(db);
  if (keyRefusal) return { ok: false, code: keyRefusal.code, message: keyRefusal.message };

  try {
    await db.superAdminAudit.create({
      data: {
        operator_user_id: args.operatorUserId,
        action: 'rep.bank_viewed',
        target_rep_id: rep.id,
        target_name_snapshot: `${rep.name} (${rep.ref_code})`,
        target_ref_snapshot: `bank details revealed · ending ${rep.bank_account_last4 ?? '????'}`,
        detail: { last4: rep.bank_account_last4 },
      },
    });
  } catch (e) {
    console.error('[payee-admin] refusing to reveal: the audit row could not be written for', rep.id, e);
    return { ok: false, code: 'audit_failed', message: 'We could not record this look, so it was not shown.' };
  }

  /**
   * ── THE DECRYPT IS WRAPPED, AND THAT IS DEFENCE IN DEPTH RATHER THAN BELT AND BRACES ──────────
   * The guard above should make this unreachable: a key that does not match this database never gets
   * here. But a red-proof that removed the guard did not merely redden a clause — it threw
   * PayeeCipherError out of this function and killed the caller, which in the Engine Room would be a
   * 500 on a button press and an operator told nothing.
   *
   * So the throw is caught and turned into the same shape every other refusal has. The guard remains
   * the thing that prevents it; this is what happens if the guard is ever bypassed, and the message
   * names the likelier cause rather than blaming the row.
   */
  try {
    return {
      ok: true,
      value: {
        accountName: rep.bank_account_name,
        sortCode: formatSortCode(decryptPayee(rep.bank_sort_code)),
        accountNumber: payeeDigits(decryptPayee(rep.bank_account_number)),
      },
    };
  } catch (e) {
    if (e instanceof PayeeCipherError || e instanceof PayeeKeyError) {
      console.error('[payee-admin] reveal passed the key check and still could not decrypt for', rep.id, e.message);
      return {
        ok: false,
        code: 'undecryptable',
        message: 'These details will not decrypt with the key this environment holds. The audit row above '
          + 'records the attempt. Do not re-run it: check which key is deployed before anything else.',
      };
    }
    throw e;
  }
}

async function auditRep(
  db: Db,
  a: { operatorUserId: string; repId: string; action: string; nameSnapshot: string; refSnapshot: string; detail: Record<string, unknown> },
): Promise<void> {
  // NO DIGITS IN ANY DETAIL above — only the last four. An audit row is read by somebody looking at
  // something else, and a diff is the commonest place a credential-grade value leaks.
  await db.superAdminAudit.create({
    data: {
      operator_user_id: a.operatorUserId,
      action: a.action,
      target_rep_id: a.repId,
      target_name_snapshot: a.nameSnapshot,
      target_ref_snapshot: a.refSnapshot,
      detail: a.detail as any,
    },
  }).catch((e) => {
    // The decision stands; the record is lost and said so loudly. Same ruling as the suspension
    // writer, and the opposite of revealPayee above — see its header for why they differ.
    console.error('[payee-admin]', a.action, 'applied but NOT audited for', a.repId, e);
  });
}
