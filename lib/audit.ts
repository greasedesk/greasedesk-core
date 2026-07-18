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
  | 'owner.edited'
  | 'vehicle.edited'
  | 'comeback.marked'       // marked as warranty/comeback (zero-revenue)
  | 'comeback.cleared'      // comeback flag removed
  | 'invoice.minted'
  | 'invoice.warranty_minted' // comeback £0 invoice from the warranty series
  | 'invoice.vin_skipped'     // minted without a VIN on the card (pre-mint backstop skip)
  | 'invoice.mileage_skipped' // minted without a mileage on the card
  | 'invoice.paid'            // attested paid → paid_pending (clearance window starts)
  | 'invoice.paid_unmarked'   // silent revert during the window (manager/admin) — nothing was sent
  | 'invoice.paid_confirmed'  // clearance window elapsed → confirmed by the cron (system actor)
  | 'invoice.unlocked'      // ADMIN-only escape hatch: frozen (issued/paid/settled) → unlocked for corrections
  | 'invoice.reissued'      // ADMIN re-freeze after an unlock: corrected lines snapshot + re-lock (warranty → settled)
  | 'invoice.lines_classified' // one-off 2026-07-12: item_type/labour_outsourced backfilled onto existing frozen lines
  | 'invoice.warranty_settled_backfilled' // one-off 2026-07-12: W-series frozen (goodwill shape) + settled
  | 'invoice.renumbered'    // deliberate ledger correction of the rendered number (one-off, admin-approved)
  | 'invoice.date_paid_edited' // the document's paid-date corrected (manager/admin)
  | 'invoice.date_issued_edited' // the document's issue/billing date corrected (manager/admin)
  | 'invoice.date_issued_backfilled' // one-off: issue-date added after minting (approved correction)
  | 'invoice.date_paid_backfilled' // one-off: paid-date set to the work-done date (approved correction)
  | 'card.hours_backfilled'   // one-off: labour_hours populated onto existing lines from current service definitions
  | 'invoice.sent'          // emailed to the customer (PDF attached)
  | 'video.uploaded';       // landing receipt: verified {key, size} via server-side HeadObject at commit
  // NB: video.upload_error was REMOVED (2026-07-14) — technical failures live in UploadTelemetry,
  // never the business audit trail. The audit trail carries business events only. Nothing technical.

/**
 * Actions recorded against a USER rather than a job card (entity: 'user'). Separate union because
 * the entity differs — same AuditLog table, same taxonomy, different subject.
 */
export type UserAuditAction =
  | 'user.sessions_revoked'  // ADMIN signed this user out of every device (stolen-phone case)
  | 'user.deactivated'       // ADMIN suspended the account: login blocked + sessions killed
  | 'user.reactivated';      // ADMIN restored a suspended account

/**
 * Same table, same discipline, subject = a USER. Sibling of writeAudit rather than a second audit
 * path: everything still lands in AuditLog through lib/audit, so there is one place to read a trail
 * from. actorUserId is WHO DID IT; targetUserId is WHO IT HAPPENED TO — for an admin acting on
 * someone else these differ, and conflating them would make the trail useless.
 */
export async function writeUserAudit(
  tx: Prisma.TransactionClient,
  args: { groupId: string; actorUserId?: string | null; targetUserId: string; action: UserAuditAction; diff?: unknown },
): Promise<void> {
  await tx.auditLog.create({
    data: {
      group_id: args.groupId,
      user_id: args.actorUserId ?? null,
      entity: 'user',
      entity_id: args.targetUserId,
      action: args.action,
      diff_json: (args.diff ?? undefined) as Prisma.InputJsonValue | undefined,
    },
  });
}

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
