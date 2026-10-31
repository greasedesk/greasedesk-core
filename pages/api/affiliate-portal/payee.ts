/**
 * File: pages/api/affiliate-portal/payee.ts
 * AN AFFILIATE PROPOSES WHO WE PAY. It writes a RepPayeeRequest and NOTHING ELSE.
 *
 * ── THIS ROUTE CANNOT MOVE MONEY, BY CONSTRUCTION ───────────────────────────────────────────────
 * It never touches Rep.bank_*, and no pay run reads the table it writes. That is the whole design:
 * an affiliate signs in with an email link, so whoever controls the mailbox controls the account —
 * and a self-serve bank form on top of that would let a compromised inbox redirect the money
 * silently. The owner applies the change in the Engine Room, where a person looks at it.
 *
 * rep-auth-gate already sweeps pages/api/rep for any route that writes the credential or a sort
 * code; this route lives outside that tree and payee-gate sweeps it with the same question.
 *
 * ── THE DIGITS ARE ENCRYPTED BEFORE THEY ARE STORED, AND NOT STORED IF THEY CANNOT BE ───────────
 * encryptPayee throws without a usable PAYEE_ENC_KEY, and this handler lets that become a 503
 * rather than catching it and writing plaintext. A bank detail we cannot encrypt is a bank detail we
 * do not take.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { prisma } from '@/lib/db';
import { requireAffiliateApi } from '@/lib/rep-auth';
import { refusePayee, normalisedPayee, refuseNomineeIsReferredStaff } from '@/lib/payee';
import { encryptPayee, payeeLast4, PayeeKeyError } from '@/lib/payee-crypto';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).end(); }
  const me = await requireAffiliateApi(req, res);
  if (!me) return; // the guard has already answered 404

  const proposal = {
    payeeKind: String(req.body?.payeeKind ?? ''),
    accountName: String(req.body?.accountName ?? ''),
    sortCode: String(req.body?.sortCode ?? ''),
    accountNumber: String(req.body?.accountNumber ?? ''),
    nomineeEmail: req.body?.nomineeEmail ?? null,
  };

  const refusal = refusePayee(proposal);
  if (refusal) return res.status(400).json({ message: refusal });

  const clean = normalisedPayee(proposal);
  const staffRefusal = await refuseNomineeIsReferredStaff(prisma as any, {
    affiliateId: me.repId,
    nomineeEmail: clean.nomineeEmail,
  });
  if (staffRefusal) return res.status(400).json({ message: staffRefusal });

  let sortCodeEnc: string;
  let accountNumberEnc: string;
  let last4: string;
  try {
    sortCodeEnc = encryptPayee(clean.sortCode);
    accountNumberEnc = encryptPayee(clean.accountNumber);
    last4 = payeeLast4(clean.accountNumber);
  } catch (e) {
    if (e instanceof PayeeKeyError) {
      // 503 AND NOT 400. The affiliate typed nothing wrong; our environment is not configured, and
      // a 400 would send them back to correct a form that is already correct.
      console.error('[affiliate-portal/payee] PAYEE_ENC_KEY unusable — refusing to store bank details', e.message);
      return res.status(503).json({ message: 'We cannot take bank details right now. Please try again shortly.' });
    }
    throw e;
  }

  /**
   * ONE PENDING REQUEST AT A TIME, superseded in the same transaction as the new one is written.
   *
   * Two pending rows would be two answers to "what has this affiliate asked for", and the approval
   * screen would have to pick one — which is a decision nobody made. The superseded row keeps its
   * date and its last4 so the history of what was asked for survives; `decided_by` stays NULL
   * because the platform superseded it, not an operator, which is the sentinel SuperAdminAudit
   * already uses for a platform action.
   */
  const created = await prisma.$transaction(async (tx) => {
    await tx.repPayeeRequest.updateMany({
      where: { rep_id: me.repId, status: 'pending' },
      data: { status: 'superseded', decided_at: new Date(), decided_by: null },
    });
    return tx.repPayeeRequest.create({
      data: {
        rep_id: me.repId,
        payee_kind: clean.payeeKind,
        account_name: clean.accountName,
        sort_code_enc: sortCodeEnc,
        account_number_enc: accountNumberEnc,
        account_last4: last4,
        nominee_email: clean.nomineeEmail,
        status: 'pending',
      },
      select: { id: true, account_last4: true },
    });
  });

  /**
   * AUDITED AS THE AFFILIATE'S OWN ACT. actor_rep_id is the affiliate and target_rep_id is the same
   * person — the column pair exists for exactly this, and the schema's own note says the bank
   * details we pay into are one of the two reasons target_rep_id was added.
   *
   * NO DIGITS IN THE DETAIL. Only the last four and the kind: an audit row is read by whoever is
   * looking at something else, and lib/redact exists because a diff is the commonest place a
   * credential-grade value leaks.
   */
  await prisma.superAdminAudit.create({
    data: {
      actor_rep_id: me.repId,
      action: 'rep.payee_requested',
      target_rep_id: me.repId,
      target_name_snapshot: clean.accountName,
      target_ref_snapshot: `${clean.payeeKind} · account ending ${created.account_last4}`,
      detail: { payee_kind: clean.payeeKind, last4: created.account_last4, request_id: created.id },
    },
  }).catch((e) => {
    // THE REQUEST STANDS. A lost audit row is a record lost, not a reason to drop something an
    // affiliate asked for — and it is logged loudly, because an unexplained payee change is exactly
    // what somebody will later need explained.
    console.error('[affiliate-portal/payee] request written but NOT audited for', me.repId, e);
  });

  return res.status(200).json({ ok: true, masked: created.account_last4 });
}
