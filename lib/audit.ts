/**
 * File: lib/audit.ts
 * THE single place a job-card audit event is recorded. Called INSIDE the same transaction as the
 * mutation it describes (status change, stage tick, accept+booking, invoice mint/pay) so an audit
 * row can never diverge from — or outlive a rolled-back — change.
 *
 * Taxonomy is deliberately small: actor (user_id) + action (stable key) + timestamp (created_at) +
 * optional diff_json. Action keys are translated for display via jobcard:audit.<action> — never
 * shown raw. The AuditLog model predates this; nothing wrote to it before this slice, so a card's
 * trail necessarily starts empty and fills going forward.
 */
import type { Prisma } from '@prisma/client';

export type AuditAction =
  | `status.${string}`      // status.accepted, status.invoiced, status.paid, status.declined, …
  | `stage.${string}`       // stage.intake.done / stage.intake.undone, …
  | 'accept.booked'
  | 'booking.moved'
  | 'booking.removed'
  | 'invoice.minted'
  | 'invoice.paid';

export async function writeAudit(
  tx: Prisma.TransactionClient,
  args: { groupId: string; userId?: string | null; jobCardId: string; action: AuditAction; diff?: unknown },
): Promise<void> {
  await tx.auditLog.create({
    data: {
      group_id: args.groupId,
      user_id: args.userId ?? null,
      entity: 'job_card',
      entity_id: args.jobCardId,
      action: args.action,
      diff_json: (args.diff ?? undefined) as Prisma.InputJsonValue | undefined,
    },
  });
}
