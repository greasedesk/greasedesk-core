/**
 * File: lib/contact-preferences.ts
 * THE ONE WRITER of a customer's contact preferences. It moves the Customer column AND appends a
 * ContactPreferenceEvent, in one transaction, or does neither. Nothing else writes sms_opt_out,
 * email_opt_out, sms_marketing_opt_out or email_marketing_opt_out — contact-preferences-gate scans
 * for a second writer. The rules it applies are lib/contact-preference-rules (a leaf).
 *
 * ── WHY THE HISTORY EXISTS ─────────────────────────────────────────────────────────────────────
 * It is what a garage may have to produce if challenged: what this customer's preference is, and
 * who set it — the staff member, the customer's own link, or their phone network refusing texts.
 * The audit log is keyed to job cards and holds a diff; it cannot answer that without searching
 * inside JSON. Every change goes through here from the day this shipped, the staff form's existing
 * toggles included, so the history is complete rather than partial.
 *
 * ── CONDITIONAL ON THE PRE-STATE ───────────────────────────────────────────────────────────────
 * The column moves only if it still holds the value this writer read (`updateMany … where column =
 * previous`, then the affected-row count). Two writers racing to record the same change produce
 * ONE event, not two, and never an event whose `previous` is a value the column no longer held.
 * No unique index and no caught error: a caught violation poisons the transaction, and the staff
 * form's transaction carries the customer's other edits (the named fact, top of schema.prisma).
 *
 * ── THE TENANT IS THE CUSTOMER'S ───────────────────────────────────────────────────────────────
 * The caller names the tenant it acts for and the customer is looked up WITHIN it; a customer of
 * another tenant is `not_found`, never written. The event's group_id is the customer row's own.
 *
 * ── A GAP LEFT OPEN, DELIBERATELY (owner, 2026-09-10) ──────────────────────────────────────────
 * Consent is keyed to the CUSTOMER, not to the address. If staff later change or delete the address
 * on an opted-out row, the opt-out does not follow the address. It only matters if that same
 * address is typed back in somewhere — nothing marketing can reach an address no customer row
 * holds. Closing it properly means keying consent to addresses rather than customers: a different
 * data model, and not this slice.
 */
import type { Prisma, PrismaClient } from '@prisma/client';
import { prisma } from '@/lib/db';
import {
  PREF_COLUMN, normaliseReason, preferenceRefusal,
  type PrefChannel, type PrefRefusal, type PrefScope, type PrefVia,
} from '@/lib/contact-preference-rules';

type Tx = Prisma.TransactionClient;

export type PreferenceChange = {
  /** The tenant the caller acts for. The customer is looked up within it. */
  groupId: string;
  customerId: string;
  channel: PrefChannel;
  scope: PrefScope;
  /** NULL = back to no record, true = opted out, false = opted in. */
  optedOut: boolean | null;
  via: PrefVia;
  reason?: string | null;
  actorUserId?: string | null;
  notificationLogId?: string | null;
};

export type PreferenceResult =
  | { ok: true; changed: false }
  | { ok: true; changed: true; eventId: string; previous: boolean | null }
  | { ok: false; refusal: PrefRefusal | 'not_found' | 'conflict' };

/** Record one change inside the caller's transaction. A no-op records nothing and says so. */
export async function setContactPreference(tx: Tx, c: PreferenceChange): Promise<PreferenceResult> {
  const refusal = preferenceRefusal(c);
  if (refusal) return { ok: false, refusal };
  const column = PREF_COLUMN[c.scope][c.channel];
  // Twice at most: the second read follows a writer that moved the column between our read and our
  // update. A third loss in a row is not a race worth retrying; it is reported.
  for (let attempt = 0; attempt < 2; attempt++) {
    const cur = await tx.customer.findFirst({
      where: { id: c.customerId, group_id: c.groupId },
      select: { group_id: true, sms_opt_out: true, email_opt_out: true, sms_marketing_opt_out: true, email_marketing_opt_out: true },
    });
    if (!cur) return { ok: false, refusal: 'not_found' };
    const previous = cur[column] ?? null;
    if (previous === c.optedOut) return { ok: true, changed: false };
    const now = new Date();
    const moved = await tx.customer.updateMany({
      where: { id: c.customerId, group_id: c.groupId, [column]: previous } as Prisma.CustomerWhereInput,
      data: { [column]: c.optedOut, opt_out_updated_at: now } as Prisma.CustomerUpdateManyMutationInput,
    });
    if (moved.count === 0) continue;
    const staff = c.via === 'staff';
    const ev = await tx.contactPreferenceEvent.create({
      data: {
        group_id: cur.group_id, customer_id: c.customerId, channel: c.channel, scope: c.scope,
        previous, opted_out: c.optedOut, via: c.via, reason: normaliseReason(c.reason),
        actor_user_id: staff ? c.actorUserId ?? null : null,
        notification_log_id: staff ? null : c.notificationLogId ?? null,
        created_at: now,
      },
      select: { id: true },
    });
    return { ok: true, changed: true, eventId: ev.id, previous };
  }
  return { ok: false, refusal: 'conflict' };
}

/** The same change in a transaction of its own — for a caller that is not already in one. */
export function recordContactPreference(c: PreferenceChange, db: PrismaClient = prisma): Promise<PreferenceResult> {
  return db.$transaction((tx) => setContactPreference(tx, c));
}
