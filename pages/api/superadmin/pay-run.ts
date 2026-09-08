/**
 * File: pages/api/superadmin/pay-run.ts
 * THE WRITE SURFACE FOR SALES COMMISSION RELEASES.
 *
 * Three actions, two roles, one predicate:
 *   release / hold  → country_manager. Reviewing a rep's month is the area manager's job.
 *   close           → owner. Closing freezes money and cannot be undone.
 *
 * Every rule lives in lib/rep-pay-run and is ASKED here, never re-derived — refuseRelease,
 * refuseHold, refuseRunChange. Nothing in this file decides whether a run is closed for itself,
 * which is how a closed run would get edited by the one path that forgot.
 *
 * REGION SCOPE holds on every action. CommissionEntry carries a bare group_id with no relation, so
 * the scope is resolved to a set of group ids and the entry is matched against it — an operator
 * with no regions matches nothing and fails closed, exactly as operatorTenantScope intends.
 *
 * Holds, overrides and signoffs are audited to SuperAdminAudit — the PLATFORM ledger. Never
 * AuditLog: that is the tenant's trail and a garage can read theirs, and what we approve paying a
 * rep for introducing them is not the garage's business.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { prisma } from '@/lib/db';
import { requireOperatorApi, operatorTenantScope, type OperatorPrincipal } from '@/lib/operator-auth';
import { releaseEntry, holdEntry, closeRun, refuseRelease, refuseHold, windowVerdict, HOLD_REASONS, RELEASE_OVERRIDE_REASONS } from '@/lib/rep-pay-run';

type Action = 'release' | 'hold' | 'close';

/**
 * WHO MAY DO WHAT, as a map rather than a ternary. Reviewing a rep's month is the area manager's
 * job; closing freezes money and cannot be undone, so it is the owner's. Written out because a
 * conditional buries the answer to "what does closing require?" inside an expression.
 */
const MIN_ROLE = { release: 'country_manager', hold: 'country_manager', close: 'owner' } as const;

/** The group ids this operator may act on. Empty for a non-owner with no regions — fails closed. */
async function groupIdsInScope(op: OperatorPrincipal): Promise<string[]> {
  const rows = await prisma.group.findMany({ where: { ...operatorTenantScope(op) }, select: { id: true } });
  return rows.map((g) => g.id);
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).json({ message: 'Method Not Allowed' }); }
  const action = (req.body?.action ?? '') as Action;

  // CLOSING IS THE OWNER'S. Releasing is the area manager's. Two roles, asked before anything else.
  const op = await requireOperatorApi(req, res, { minRole: MIN_ROLE[action] ?? 'owner' });
  if (!op) return;

  if (action === 'close') {
    const runId = String(req.body?.runId ?? '');
    const signoff = String(req.body?.signoff ?? '');
    const result = await closeRun(prisma, { runId, operatorId: op.userId, signoff });
    if (!result.ok) return res.status(result.code === 'signoff_required' ? 400 : 409).json({ code: result.code });
    const run = await prisma.repPayRun.findUnique({ where: { id: runId }, select: { period: true, snapshot_line_count: true, snapshot_amount_pennies: true } });
    await prisma.superAdminAudit.create({
      data: {
        operator_user_id: op.userId,
        action: 'commission.run_closed',
        target_name_snapshot: `Sales Commission run ${run?.period ?? runId}`,
        reason: signoff,
        detail: { runId, lines: run?.snapshot_line_count ?? null, amountPennies: run?.snapshot_amount_pennies ?? null },
      },
    });
    return res.status(200).json({ ok: true });
  }

  const entryId = String(req.body?.entryId ?? '');
  const scope = await groupIdsInScope(op);
  const entry = await prisma.commissionEntry.findFirst({
    where: { id: entryId, group_id: { in: scope } },
    select: { id: true, group_id: true, party_type: true, party_id: true, period: true, status: true, pay_run_id: true },
  });
  // OUT OF REGION READS AS ABSENT, the same 404 the guards use — an operator must not learn that a
  // line exists somewhere they cannot see.
  if (!entry) return res.status(404).json({ message: 'Not found.' });

  const visits = await prisma.repVisit.findMany({
    where: { group_id: entry.group_id, party_type: entry.party_type, party_id: entry.party_id, satisfies_period: { not: null } },
    orderBy: { scanned_at: 'desc' }, select: { scanned_at: true, satisfies_period: true },
  });
  const match = visits.find((v) => v.satisfies_period === entry.period) ?? null;
  const previous = visits.find((v) => (v.satisfies_period ?? '') < entry.period) ?? null;
  const verdict = windowVerdict({ period: entry.period, visitAt: match?.scanned_at ?? null, previousVisitAt: previous?.scanned_at ?? null });
  const line = { status: entry.status, payRunId: entry.pay_run_id, windowPass: verdict.pass, hasVisit: !!match };

  if (action === 'hold') {
    const holdReason = req.body?.holdReason ?? null;
    const no = refuseHold(line, { holdReason });
    if (no) return res.status(no.code === 'already_released' ? 409 : 400).json(no);
    const done = await holdEntry(prisma, { entryId, operatorId: op.userId, holdReason });
    if (!done.ok) return res.status(409).json({ code: done.code });
    await writeNote(entryId, 'hold', req.body?.note, op.userId);
    await audit(op.userId, 'commission.line_held', entry, { holdReason });
    return res.status(200).json({ ok: true });
  }

  if (action === 'release') {
    const overrideReason = req.body?.overrideReason ?? null;
    const no = refuseRelease(line, { overrideReason });
    if (no) return res.status(no.code === 'already_released' ? 409 : 400).json(no);
    const runId = String(req.body?.runId ?? '');
    const done = await releaseEntry(prisma, { entryId, runId, operatorId: op.userId, shownAsVisited: !!match, overrideReason });
    if (!done.ok) return res.status(409).json({ code: done.code });
    if (overrideReason) await writeNote(entryId, 'release_override', req.body?.note, op.userId);
    await audit(op.userId, 'commission.line_released', entry, { runId, overrideReason, shownAsVisited: !!match });
    return res.status(200).json({ ok: true });
  }

  return res.status(400).json({ message: 'Unknown action.' });
}

/** The sentence beside the code, when the manager wrote one. Blank is simply no note. */
async function writeNote(entryId: string, kind: 'hold' | 'release_override', body: unknown, by: string) {
  const text = typeof body === 'string' ? body.trim() : '';
  if (!text) return;
  await prisma.commissionEntryNote.create({ data: { entry_id: entryId, kind, body: text, written_by: by } });
}

async function audit(operatorId: string, action: string, entry: { id: string; group_id: string; period: string; party_id: string }, detail: unknown) {
  await prisma.superAdminAudit.create({
    data: {
      operator_user_id: operatorId,
      action,
      target_group_id: entry.group_id,
      target_name_snapshot: `Sales Commission ${entry.period}`,
      detail: { entryId: entry.id, partyId: entry.party_id, ...(detail as object) },
    },
  });
}

/** Exported for the screen so the two cannot drift on what a form may offer. */
export const REASON_SETS = { hold: HOLD_REASONS, override: RELEASE_OVERRIDE_REASONS };
