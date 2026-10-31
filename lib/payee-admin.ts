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
import { decryptPayee, payeeDigits } from '@/lib/payee-crypto';
import { formatSortCode, maskedForOwner } from '@/lib/payee';

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

  return {
    ok: true,
    value: {
      accountName: rep.bank_account_name,
      sortCode: formatSortCode(decryptPayee(rep.bank_sort_code)),
      accountNumber: payeeDigits(decryptPayee(rep.bank_account_number)),
    },
  };
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
