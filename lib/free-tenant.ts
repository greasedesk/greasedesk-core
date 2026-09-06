/**
 * File: lib/free-tenant.ts
 * THE writer for Group.free_since — the one place a garage becomes free, or stops being free.
 *
 * ── WHY A WRITER EXISTS AT ALL ──────────────────────────────────────────────────────────────────
 * It did not, until now. `free_since` was written by a script typing `data: { free_since: new Date() }`
 * straight onto the row, so nothing could refuse and nothing recorded it beyond whatever the script
 * chose to say. GB-GD1967 was set free on 5 September and took a real subscription on the 6th; the
 * two states are mutually exclusive and the contradiction sat there until a person noticed a broken
 * screen. A predicate that is read through one chokepoint (lib/demo-tenant::isFree) and written
 * through none is only half a rule.
 *
 * ── NOT IN lib/demo-tenant, DELIBERATELY ────────────────────────────────────────────────────────
 * isFree and neverSubscribes live there and stay there. But lib/notify imports that module for
 * demoSendDecision, so it sits on the import graph of every message the product sends — and putting
 * operator-audit writing on that path widens what a text message drags in for no reason. The read
 * predicate is cheap and universal; the writer is heavy and rare. They are different jobs.
 *
 * ── BOTH LEDGERS, ONE TRANSACTION ───────────────────────────────────────────────────────────────
 * SuperAdminAudit because the platform decided something about a tenant, and the tenant's own
 * AuditLog because it is their money — the pattern pages/api/superadmin/trial-extend set, and which
 * ten other operator writes still owe.
 *
 * The transaction is what makes the ordering safe. clear-stranded-subscriptions and
 * clear-tmbs-free-flag had to write the audit row FIRST and read it back, because a script cannot
 * roll a failed write back and the row was the only surviving copy of what it removed. Here the
 * update and both rows commit together or not at all, which is strictly stronger — so the read-back
 * dance is gone rather than copied.
 */
import { prisma } from '@/lib/db';
import { writeAudit } from '@/lib/audit';

/**
 * The statuses that mean money is actually moving, or about to. `past_due` counts: Stripe is still
 * retrying a real card on a real subscription. `canceled`, `incomplete` and `unpaid` do NOT — a
 * dead subscription overtakes nothing, and treating one as live would clear a free decision on the
 * strength of a subscription that ended.
 *
 * The same set the onboarding gate uses for step (F), stated here rather than imported so the two
 * cannot be changed apart by accident — they answer different questions that happen to share a list.
 */
export const LIVE_SUBSCRIPTION_STATUS = new Set(['trialing', 'active', 'past_due']);
export const isLiveSubscription = (status: string | null | undefined): boolean =>
  LIVE_SUBSCRIPTION_STATUS.has(status ?? '');

type Client = Pick<typeof prisma, 'group'> & { auditLog: any; superAdminAudit: any };

export type FreeRefusalCode = 'not_found' | 'already_free' | 'live_subscription';
export type SetFreeResult =
  | { ok: true; freeSince: Date }
  | { ok: false; code: FreeRefusalCode; message: string };

/**
 * Declare a garage free. Refuses a tenant that is being charged: the refusal is the whole point of
 * the file, and it is stated BEFORE the write rather than checked afterwards.
 *
 * Refuses an already-free tenant too, rather than re-dating the decision — "free since when" is a
 * question somebody will ask, and overwriting the date erases the answer.
 */
export async function setFree(args: {
  groupId: string;
  reason: string;
  operatorUserId: string;
}): Promise<SetFreeResult> {
  const g = await prisma.group.findUnique({
    where: { id: args.groupId },
    select: { id: true, group_name: true, ref: true, free_since: true,
      billing: { select: { subscription_status: true, stripe_subscription_id: true } } },
  });
  if (!g) return { ok: false, code: 'not_found', message: 'No such tenant.' };
  if (g.free_since) {
    return { ok: false, code: 'already_free',
      message: `Already free since ${g.free_since.toISOString().slice(0, 10)}. Re-dating would erase when the decision was taken.` };
  }
  const status = g.billing?.subscription_status ?? null;
  if (isLiveSubscription(status)) {
    return { ok: false, code: 'live_subscription',
      message: `This tenant has a live subscription (${status}). Free and subscribed are mutually exclusive — cancel the subscription first, or leave it as a paying customer.` };
  }

  const freeSince = new Date();
  await prisma.$transaction(async (tx) => {
    await tx.group.update({ where: { id: g.id }, data: { free_since: freeSince, free_reason: args.reason } });
    await tx.superAdminAudit.create({
      data: {
        operator_user_id: args.operatorUserId,
        action: 'tenant.free_flag_set',
        target_group_id: g.id, target_operator_id: null,
        target_name_snapshot: g.group_name,
        target_ref_snapshot: g.ref == null ? null : String(g.ref),
        reason: args.reason,
        detail: { freeSince: freeSince.toISOString(), subscriptionStatus: status },
      },
    });
    // THEIR ledger too: somebody outside the business changed whether they get charged.
    await writeAudit(tx, {
      groupId: g.id, userId: null, entity: 'group', entityId: g.id,
      action: 'billing.free_flag_set',
      diff: { freeSince: freeSince.toISOString(), reason: args.reason },
    });
  });
  return { ok: true, freeSince };
}

export type ClearFreeResult = { cleared: boolean; freeSince: Date | null };

/**
 * Stop a garage being free.
 *
 * `operatorUserId` is null when the platform did it by itself — the Stripe cache writer reconciling
 * a decision a live subscription has overtaken. SuperAdminAudit.operator_user_id is nullable for
 * exactly that case; a sentinel id would be a lie in the table whose job is saying who acted.
 *
 * Takes an optional transaction client so the reconciliation can commit in the SAME transaction as
 * the billing write that caused it. That matters: if the subscription write commits and this does
 * not, the contradiction is back and nothing will look again.
 *
 * Returns cleared:false when there was nothing to clear, and writes NOTHING in that case — a
 * webhook fires repeatedly, and an audit row per delivery for a clear that did not happen would
 * bury the one that did.
 */
export async function clearFree(
  args: { groupId: string; reason: string; operatorUserId: string | null; detail?: Record<string, unknown> },
  client?: Client,
): Promise<ClearFreeResult> {
  const db = (client ?? prisma) as Client;
  const g = await db.group.findUnique({
    where: { id: args.groupId },
    select: { id: true, group_name: true, ref: true, free_since: true, free_reason: true },
  });
  if (!g || !g.free_since) return { cleared: false, freeSince: null };
  const wasFreeSince = g.free_since;

  const run = async (tx: Client) => {
    // ONLY free_since and free_reason. is_demo and is_internal answer different questions and are
    // not overtaken by being charged — a demo that acquires a subscription is a bug to shout about,
    // not a flag to quietly reconcile.
    await tx.group.update({ where: { id: g.id }, data: { free_since: null, free_reason: null } });
    await tx.superAdminAudit.create({
      data: {
        operator_user_id: args.operatorUserId,
        action: 'tenant.free_flag_cleared',
        target_group_id: g.id, target_operator_id: null,
        target_name_snapshot: g.group_name,
        target_ref_snapshot: g.ref == null ? null : String(g.ref),
        reason: args.reason,
        // The previous decision, preserved: after this row there is no other copy of it.
        detail: { freeSince: wasFreeSince.toISOString(), freeReason: g.free_reason, ...(args.detail ?? {}) },
      },
    });
    await writeAudit(tx as any, {
      groupId: g.id, userId: null, entity: 'group', entityId: g.id,
      action: 'billing.free_flag_cleared',
      diff: { freeSince: wasFreeSince.toISOString(), freeReason: g.free_reason, reason: args.reason },
    });
  };

  if (client) await run(client);
  else await prisma.$transaction(async (tx) => run(tx as unknown as Client));
  return { cleared: true, freeSince: wasFreeSince };
}
