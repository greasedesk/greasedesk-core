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
  PREF_COLUMN, blocksSend, channelBlock, customerAddressWhere, normaliseReason, preferenceRefusal,
  type PrefChannel, type PrefRefusal, type PrefScope, type PrefVia,
} from '@/lib/contact-preference-rules';
import { UNSUBSCRIBE_TOKEN } from '@/lib/unsubscribe-links';

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

// ── A CARRIER STOP (step 2, 2026-09-11) ────────────────────────────────────────────────────────────
/**
 * THE PHONE NETWORK SAID THIS HANDSET REPLIED STOP. Before this, Twilio blocked the number and we
 * recorded a failed send — and the marketing board kept offering texts to a person who had said no.
 * The one place a real person refused and we ignored it (owner, 2026-09-10).
 *
 * Marks "no texts at all" (scope `all`, not marketing: the carrier now refuses EVERY text to that
 * handset from our sender, a quote as much as an offer) on every customer IN THE SENDING GARAGE who
 * holds the number, through the one writer, citing the message the STOP came back on.
 *
 * ONLY THE SENDING GARAGE (owner, 2026-09-10). Every tenant texts through one GreaseDesk sender, so
 * Twilio now blocks that handset for all of them. Another garage's first text to it gets its own
 * 21610 and is marked then: one refused attempt per other garage, no message ever delivered, and
 * each garage's consent record stays its own.
 *
 * NOT UNDONE HERE. There is no inbound-SMS route, so a customer replying START unblocks them at the
 * carrier and nothing tells us. Staff clear it on the customer record — with a reason, enforced in
 * this writer at step 6, because it depends on earlier history the database cannot see.
 *
 * Idempotent: a second STOP for the same number records nothing new. Never throws to its caller —
 * a send path and a webhook both call it, and neither must fail because the marking did.
 */
export type CarrierStopResult =
  | { recorded: true; customers: number; changed: number }
  | { recorded: false; why: 'no_such_message' | 'not_a_tenant_send' | 'not_a_text' | 'no_customer_holds_the_number' | 'refused' | 'threw'; detail?: string };

/** Thrown INSIDE the transaction so a refusal on the second holder rolls back the first. */
// An explicit field, not a constructor parameter property: gates load lib/ through node's type
// stripping, which refuses that syntax (ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX).
class CarrierStopRefused extends Error { refusal: string; constructor(refusal: string) { super(refusal); this.refusal = refusal; } }

export async function recordCarrierStop(notificationLogId: string, db: PrismaClient = prisma): Promise<CarrierStopResult> {
  try {
    const log = await db.notificationLog.findUnique({ where: { id: notificationLogId }, select: { group_id: true, channel: true, recipient: true } });
    if (!log) return { recorded: false, why: 'no_such_message' };
    if (!log.group_id) return { recorded: false, why: 'not_a_tenant_send' };
    if (log.channel !== 'sms') return { recorded: false, why: 'not_a_text' };
    const groupId = log.group_id;
    return await db.$transaction(async (tx) => {
      const holders = await tx.customer.findMany({ where: customerAddressWhere(groupId, 'sms', log.recipient) as Prisma.CustomerWhereInput, select: { id: true } });
      if (!holders.length) return { recorded: false as const, why: 'no_customer_holds_the_number' as const };
      let changed = 0;
      for (const h of holders) {
        const r = await setContactPreference(tx, { groupId, customerId: h.id, channel: 'sms', scope: 'all', optedOut: true, via: 'carrier_stop', notificationLogId });
        if (!r.ok) throw new CarrierStopRefused(r.refusal); // all or none: never half a household
        if (r.changed) changed++;
      }
      return { recorded: true as const, customers: holders.length, changed };
    });
  } catch (e) {
    if (e instanceof CarrierStopRefused) return { recorded: false, why: 'refused', detail: e.refusal };
    return { recorded: false, why: 'threw', detail: e instanceof Error ? e.message.slice(0, 200) : String(e) };
  }
}

// ── THE CUSTOMER'S OWN LINK (step 4, 2026-09-11) ──────────────────────────────────────────────────
/**
 * A GARAGE'S UNSUBSCRIBE LINK, followed. The token is on the marketing email's own NotificationLog row
 * (minted by lib/notify), which says which garage, which channel and which address received it.
 *
 * WHAT IT STOPS: "no reminders or offers" on THAT channel — scope `marketing`, never `all` (decision
 * B): their quote and their invoice still reach them. The link came in an email, so it answers for
 * email; a text has its own way out (a carrier STOP, and the SMS link the owner is deciding on).
 * WHO: every customer IN THAT GARAGE holding the address — the same match the send path refuses by
 * (customerAddressWhere) — through the one writer, citing the message. All or none.
 * REPEATABLE: a second click, or a mail client's one-click POST after the page button, records
 * nothing new. The view is read-only: OPENING the link never acts, because mail scanners open links.
 */
const LINK_COLUMNS = { sms_opt_out: true, email_opt_out: true, sms_marketing_opt_out: true, email_marketing_opt_out: true } as const;

async function linkedMessage(token: string, db: PrismaClient) {
  if (!UNSUBSCRIBE_TOKEN.test(token)) return null; // not a shape we mint — no database lookup at all
  const row = await db.notificationLog.findUnique({
    where: { unsubscribe_token: token },
    select: { id: true, group_id: true, channel: true, recipient: true, group: { select: { group_name: true, trading_name: true } } },
  });
  if (!row || !row.group_id || !row.group) return null;
  return { id: row.id, groupId: row.group_id, channel: row.channel as PrefChannel, recipient: row.recipient,
    garage: row.group.trading_name || row.group.group_name };
}

export type UnsubscribeView =
  | { state: 'unknown' }
  | { state: 'ready' | 'done' | 'nothing_on_file'; garage: string; channel: PrefChannel };

/** What the page shows. READ-ONLY — never the address, never a write. */
export async function unsubscribeView(token: string, db: PrismaClient = prisma): Promise<UnsubscribeView> {
  const m = await linkedMessage(token, db);
  if (!m) return { state: 'unknown' };
  const holders = await db.customer.findMany({ where: customerAddressWhere(m.groupId, m.channel, m.recipient) as Prisma.CustomerWhereInput, select: LINK_COLUMNS });
  if (!holders.length) return { state: 'nothing_on_file', garage: m.garage, channel: m.channel };
  const done = holders.every((h) => blocksSend(channelBlock(h, m.channel), true));
  return { state: done ? 'done' : 'ready', garage: m.garage, channel: m.channel };
}

export type UnsubscribeResult =
  | { ok: true; garage: string; channel: PrefChannel; customers: number; changed: number }
  | { ok: false; why: 'unknown' | 'refused' | 'threw'; detail?: string };

class LinkRefused extends Error { refusal: string; constructor(refusal: string) { super(refusal); this.refusal = refusal; } }

/** The act — the page's button and the RFC 8058 one-click POST both land here. */
export async function unsubscribeByLink(token: string, db: PrismaClient = prisma): Promise<UnsubscribeResult> {
  try {
    const m = await linkedMessage(token, db);
    if (!m) return { ok: false, why: 'unknown' };
    return await db.$transaction(async (tx) => {
      const holders = await tx.customer.findMany({ where: customerAddressWhere(m.groupId, m.channel, m.recipient) as Prisma.CustomerWhereInput, select: { id: true } });
      let changed = 0;
      for (const h of holders) {
        const r = await setContactPreference(tx, { groupId: m.groupId, customerId: h.id, channel: m.channel, scope: 'marketing', optedOut: true, via: 'customer_link', notificationLogId: m.id });
        if (!r.ok) throw new LinkRefused(r.refusal);
        if (r.changed) changed++;
      }
      return { ok: true as const, garage: m.garage, channel: m.channel, customers: holders.length, changed };
    });
  } catch (e) {
    if (e instanceof LinkRefused) return { ok: false, why: 'refused', detail: e.refusal };
    return { ok: false, why: 'threw', detail: e instanceof Error ? e.message.slice(0, 200) : String(e) };
  }
}
