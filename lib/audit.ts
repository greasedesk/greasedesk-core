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
  // RETIRED 2026-08-05, RETAINED FOR HISTORY. No longer written: acceptance is one action
  // (`quote.accepted`, with `via` in the diff) through lib/quote-acceptance. The existing rows are
  // the ONLY dated evidence for the acceptances that predate that file, so any reader looking
  // further back than 2026-08-05 must take the UNION of accept.booked, quote.accepted_verbal and
  // quote.accepted. AuditLog is append-only; these are never deleted.
  | 'accept.booked'
  | 'booking.placed'     // the DIARY placement made by accept-and-book — the acceptance is its own row
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
  | 'invoice.voided'        // ADMIN retires a document issued in error; number + frozen lines RETAINED (VATREC5010)
  | 'historical.recorded'    // an invoice issued under a PREVIOUS system, recorded (never minted chargeable)
  | 'invoice.void_reason_amended' // ADMIN improves the wording; APPEND-ONLY — the original survives in the log
  | 'invoice.lines_classified' // one-off 2026-07-12: item_type/labour_outsourced backfilled onto existing frozen lines
  | 'invoice.warranty_settled_backfilled' // one-off 2026-07-12: W-series frozen (goodwill shape) + settled
  | 'invoice.renumbered'    // deliberate ledger correction of the rendered number (one-off, admin-approved)
  | 'invoice.date_paid_edited' // the document's paid-date corrected (manager/admin)
  | 'invoice.date_issued_edited' // the document's issue/billing date corrected (manager/admin)
  | 'invoice.date_issued_backfilled' // one-off: issue-date added after minting (approved correction)
  | 'invoice.date_paid_backfilled' // one-off: paid-date set to the work-done date (approved correction)
  | 'card.hours_backfilled'   // one-off: labour_hours populated onto existing lines from current service definitions
  | 'invoice.sent'          // emailed to the customer (PDF attached)
  | 'quote.cost_entered' // a parts cost typed on the quote line (ruling 2026-07-20): { line, from, to, via, meaning }
  | 'quote.sent'         // a frozen QuoteVersion went to the customer: { version, lines, emailed, sentTo }
  | 'quote.superseded'   // the estimate was MATERIALLY edited while a quote was out — old version + link killed: { superseded }
  | 'quote.edit_immaterial' // an estimate write reproduced the live version's customer-visible figures — quote LEFT LIVE: { version }
  | 'quote.accepted'     // THE acceptance action, every door: { via:'link'|'counter'|'booked',
                         // attested, versionId, version, grossPennies, frozenVersion, from, at }.
                         // `attested` false = garage-recorded; only via:'link' carries ip/user-agent.
  | 'quote.declined'     // CUSTOMER declined, via magic link: { version, grossPennies, at, ip, userAgent }
  | 'quote.accepted_verbal' // RETIRED 2026-08-05, RETAINED FOR HISTORY — see accept.booked above.
                            // Superseded by quote.accepted with via:'counter', attested:false.
  | 'checkout.failed'     // Stripe refused to create a Checkout session. Carries Stripe's own
                         // message, code and REQUEST ID — without these the 502 is undiagnosable
                         // from outside: { detail, stripeCode, requestId, quantity, currency }
  | 'catalogue.deleted'  // a price-list entry was REMOVED — only ever possible when nothing had
                         // used it (lib/catalogue-retire). SELF-DESCRIBING: after this the item is
                         // gone and this row is the only record it existed:
                         // { code, name, itemType, active, jobLines, promoTargets }
  | 'catalogue.retired'  // active flipped — history untouched, gone from the estimate picker
  | 'card.duplicated'    // created by copying a source card's estimate — SELF-DESCRIBING: the diff
                         // carries { source_card_id, source_registration, ... } so the row stays
                         // searchable even after the duplicated_from edge is SetNull'd by a purge
  | 'video.uploaded';       // landing receipt: verified {key, size} via server-side HeadObject at commit
  // NB: video.upload_error was REMOVED (2026-07-14) — technical failures live in UploadTelemetry,
  // never the business audit trail. The audit trail carries business events only. Nothing technical.

/**
 * Actions recorded against a USER rather than a job card (entity: 'user'). Separate union because
 * the entity differs — same AuditLog table, same taxonomy, different subject.
 */
/** Batch-level import events (entity: 'import_batch'). The job-card trail records what happened to
 *  a CARD; this records what happened to the BATCH — who uploaded it, what was ingested, what was
 *  committed or skipped and why. Without it "where did that invoice go?" has no answer. */
export type ImportAuditAction =
  | 'import.batch_created'
  | 'import.ingested'      // { count, reconciled, failed }
  | 'import.committed'     // { external_ref, invoice_number, job_card_id }
  | 'import.skipped'       // { external_ref, reason }
  | 'import.batch_closed'   // { committed, skipped, total }
  // SPLIT events. A split re-expresses a printed line, so losing one silently loses the operator's
  // reasoning about what the money was. 100002293's split vanished with nothing to attribute it to
  // because these did not exist; the child shape is recorded so a lost split can be reconstructed.
  | 'import.split_created'  // { external_ref, line, parentAmount, children[], appliedTo }
  | 'import.split_replaced' // as created, plus previous[]
  | 'import.split_cleared'  // { external_ref, line, previous[], removed }
  // A LINE DECLARATION: which section a line sits in, i.e. whether it is asked for a cost or for
  // hours. Batch-wide and one click away, so it is recorded like any other money-shaping decision.
  | 'import.line_declared'  // { external_ref, line, from, to, via, alsoAppliedTo }
  // THE UNWIND: an already-committed imported invoice rebuilt from staging through the fixed path
  // and re-frozen against its source document. Records what was written vs what the document
  // printed, and that no number was drawn.
  | 'import.recommitted';  // { external_ref, invoice_number, sequence_value, written, printed, … }

/** Thread events (entity: 'message_thread'). A PERSON deciding to contact a customer is a distinct
 *  act from the system emitting a quote or a receipt — the system's sends are recorded in
 *  NotificationLog and nowhere else, deliberately. This records the decision, not the delivery. */
export type ThreadAuditAction =
  | 'message.sent_by_staff';  // { channel, recipient, chars, notificationId, status }

export type UserAuditAction =
  | 'user.sessions_revoked'  // ADMIN signed this user out of every device (stolen-phone case)
  | 'user.deactivated'       // ADMIN suspended the account: login blocked + sessions killed
  | 'user.reactivated'       // ADMIN restored a suspended account
  | 'user.email_changed';    // user changed their own LOGIN email (from/to in diff) — a credential change

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

/** Same table, same discipline, subject = a MESSAGE THREAD. Sibling of writeAudit/writeUserAudit —
 *  everything still lands in AuditLog through lib/audit, so a trail is read from one place. */
export async function writeThreadAudit(
  tx: Prisma.TransactionClient,
  args: { groupId: string; actorUserId?: string | null; threadId: string; action: ThreadAuditAction; diff?: unknown },
): Promise<void> {
  await tx.auditLog.create({
    data: {
      group_id: args.groupId,
      user_id: args.actorUserId ?? null,
      entity: 'message_thread',
      entity_id: args.threadId,
      action: args.action,
      diff_json: (args.diff ?? undefined) as Prisma.InputJsonValue | undefined,
    },
  });
}

/** Same table, same discipline, subject = an IMPORT BATCH. Sibling of writeAudit/writeUserAudit
 *  rather than a third audit path: everything still lands in AuditLog through lib/audit. */
export async function writeImportAudit(
  tx: Prisma.TransactionClient,
  args: { groupId: string; actorUserId?: string | null; batchId: string; action: ImportAuditAction; diff?: unknown },
): Promise<void> {
  await tx.auditLog.create({
    data: {
      group_id: args.groupId,
      user_id: args.actorUserId ?? null,
      entity: 'import_batch',
      entity_id: args.batchId,
      action: args.action,
      diff_json: (args.diff ?? undefined) as Prisma.InputJsonValue | undefined,
    },
  });
}

/**
 * Most audit rows are about a JOB CARD, which is why `jobCardId` is the common shape. A few are
 * about something else entirely — deleting a price-list entry leaves nothing else behind, so the
 * row has to name the catalogue item. The union keeps the common call unchanged and makes the
 * other form spell out what it is describing, rather than smuggling a foreign id into a field
 * every reader assumes is a job card.
 */
export type AuditTarget =
  | { jobCardId: string; entity?: undefined; entityId?: undefined }
  | { jobCardId?: undefined; entity: string; entityId: string };

export async function writeAudit(
  tx: Prisma.TransactionClient,
  args: { groupId: string; userId?: string | null; action: AuditAction; diff?: unknown } & AuditTarget,
): Promise<void> {
  await tx.auditLog.create({
    data: {
      group_id: args.groupId,
      user_id: args.userId ?? null,
      entity: args.entity ?? 'job_card',
      entity_id: args.entityId ?? (args.jobCardId as string),
      action: args.action,
      diff_json: (args.diff ?? undefined) as Prisma.InputJsonValue | undefined,
    },
  });
}
