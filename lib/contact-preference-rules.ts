/**
 * File: lib/contact-preference-rules.ts
 * THE RULES FOR A CONTACT-PREFERENCE CHANGE — pure, and a LEAF. It imports nothing, because the
 * staff form will read it in the browser (step 6), and a leaf is the only shape that can never ship
 * Prisma to a page (leaf-module-for-client-constants). The writer is lib/contact-preferences.
 *
 * Every refusal below MIRRORS a CHECK in migration 20260910230000_contact_preference_history. The
 * database is the enforcement; this is what keeps it unreachable from our own writer. A caught
 * constraint violation poisons the transaction it is in (the named fact at the top of
 * schema.prisma), and the staff form's transaction also carries the customer's other edits — so the
 * writer refuses in code first and the CHECK only ever meets a writer that is not ours.
 * contact-preferences-gate drives one table of cases through BOTH and asserts they agree.
 */

export const PREF_CHANNELS = ['email', 'sms'] as const;
export type PrefChannel = (typeof PREF_CHANNELS)[number];

/** `all` = nothing on this channel. `marketing` = no reminders or offers (owner decision B). */
export const PREF_SCOPES = ['all', 'marketing'] as const;
export type PrefScope = (typeof PREF_SCOPES)[number];

export const PREF_VIAS = ['staff', 'customer_link', 'carrier_stop'] as const;
export type PrefVia = (typeof PREF_VIAS)[number];

/** Which Customer column each (scope, channel) moves. The only map from a choice to a column. */
export const PREF_COLUMN = {
  all: { email: 'email_opt_out', sms: 'sms_opt_out' },
  marketing: { email: 'email_marketing_opt_out', sms: 'sms_marketing_opt_out' },
} as const satisfies Record<PrefScope, Record<PrefChannel, string>>;
export type PrefColumn = (typeof PREF_COLUMN)[PrefScope][PrefChannel];

export const REASON_MAX = 500;

export type PrefChangeShape = {
  channel: string; scope: string; via: string;
  /** NULL = back to no record, true = opted out, false = opted in. */
  optedOut: boolean | null;
  reason?: string | null; actorUserId?: string | null; notificationLogId?: string | null;
};

export type PrefRefusal =
  | 'bad_channel' | 'bad_scope' | 'bad_via'
  | 'staff_names_the_staff_member'      // _actor_chk
  | 'staff_names_no_message'            // _message_chk
  | 'source_names_its_message'          // _message_chk
  | 'source_names_no_staff_member'      // _actor_chk
  | 'link_only_opts_out_of_marketing'   // _source_chk
  | 'carrier_only_stops_all_sms'        // _source_chk
  | 'marketing_needs_an_answer'         // _marketing_definite_chk
  | 'optin_needs_a_reason'              // _optin_reason_chk
  | 'reason_too_long';                  // _reason_chk

/** A reason is a sentence or nothing: trimmed, and blank becomes NULL rather than an empty string. */
export function normaliseReason(r: string | null | undefined): string | null {
  const t = String(r ?? '').trim();
  return t === '' ? null : t;
}

/** WHY THIS CHANGE CANNOT BE RECORDED — or null. Pure; the mirror of the database's CHECKs. */
export function preferenceRefusal(c: PrefChangeShape): PrefRefusal | null {
  if (!(PREF_CHANNELS as readonly string[]).includes(c.channel)) return 'bad_channel';
  if (!(PREF_SCOPES as readonly string[]).includes(c.scope)) return 'bad_scope';
  if (!(PREF_VIAS as readonly string[]).includes(c.via)) return 'bad_via';
  const staff = c.via === 'staff';
  if (staff && !c.actorUserId) return 'staff_names_the_staff_member';
  if (staff && c.notificationLogId) return 'staff_names_no_message';
  if (!staff && !c.notificationLogId) return 'source_names_its_message';
  if (!staff && c.actorUserId) return 'source_names_no_staff_member';
  if (c.via === 'customer_link' && !(c.scope === 'marketing' && c.optedOut === true)) return 'link_only_opts_out_of_marketing';
  if (c.via === 'carrier_stop' && !(c.scope === 'all' && c.channel === 'sms' && c.optedOut === true)) return 'carrier_only_stops_all_sms';
  if (c.scope === 'marketing' && c.optedOut === null) return 'marketing_needs_an_answer';
  const reason = normaliseReason(c.reason);
  if (staff && c.scope === 'marketing' && c.optedOut === false && !reason) return 'optin_needs_a_reason';
  if (reason && reason.length > REASON_MAX) return 'reason_too_long';
  return null;
}

// ── WHICH CUSTOMERS AN ADDRESS IS (2026-09-11) ─────────────────────────────────────────────────────
/**
 * THE ONE MATCH from an address to a garage's customers — read by the send path's opt-out check
 * (lib/notify::isSuppressed), by a carrier STOP, and by the unsubscribe link (step 4). Three readers
 * of one rule, so a number that counts as "this customer" when refusing a send is the same number
 * that counts when recording that they said stop.
 *
 * ANY matching row, not the first: one number can belong to two customers (a couple, a household, a
 * company handset). A carrier STOP is the HANDSET refusing texts from our sender, so every row that
 * holds the number is marked — and suppression already refuses on any of them.
 * Email compares case-insensitively; SMS reads the dialable column first and the raw one as a
 * fallback for rows written before normalisation existed. Returns a Prisma `where` as a plain
 * object, because this file imports nothing.
 */
export function customerAddressWhere(groupId: string, channel: PrefChannel, address: string): Record<string, unknown> {
  const to = address.trim();
  return channel === 'email'
    ? { group_id: groupId, email: { equals: to, mode: 'insensitive' } }
    : { group_id: groupId, OR: [{ phone_e164: to }, { phone: to }] };
}

// ── A CARRIER STOP (2026-09-11) ────────────────────────────────────────────────────────────────────
/**
 * Twilio 21610 — "Attempt to send to unsubscribed recipient": the handset replied STOP to our sender,
 * and the carrier now refuses every text to it until they reply START. It arrives two ways — in the
 * error body when a send is refused outright (`sms 400: {"code":21610,…}`), and as `ErrorCode` on
 * the delivery callback (stored as `twilio 21610`). Matched as a whole number, so a phone number or
 * another code that merely CONTAINS the digits is not one.
 */
export const CARRIER_STOP_CODE = '21610';
export function isCarrierStop(errorText: string | null | undefined): boolean {
  return /(?<!\d)21610(?!\d)/.test(String(errorText ?? ''));
}

// ── WHAT A CUSTOMER'S PREFERENCE BLOCKS (step 3, 2026-09-11) ──────────────────────────────────────
/**
 * THE ONE READING of a customer's four preference columns, for one channel. Read by the send path
 * (lib/notify::isSuppressed), the marketing board, the marketing lists and the send preview — so
 * what a garage is offered and what the send path allows cannot disagree.
 *   'all'       — "nothing on this channel": refuses every message but a security one
 *   'marketing' — "no reminders or offers": refuses MARKETING only (owner decision B)
 *   null        — no refusal on record. NULL means unknown, and unknown is not a refusal.
 * 'all' wins when both are set: it is the stronger answer, and the one staff must see.
 */
export type PrefColumns = {
  sms_opt_out: boolean | null; email_opt_out: boolean | null;
  sms_marketing_opt_out: boolean | null; email_marketing_opt_out: boolean | null;
};
export type ChannelBlock = 'all' | 'marketing' | null;

export function channelBlock(c: PrefColumns, channel: PrefChannel): ChannelBlock {
  if ((channel === 'email' ? c.email_opt_out : c.sms_opt_out) === true) return 'all';
  if ((channel === 'email' ? c.email_marketing_opt_out : c.sms_marketing_opt_out) === true) return 'marketing';
  return null;
}

/** DECISION B, as one line: a marketing opt-out stops marketing, and never a quote or an invoice. */
export function blocksSend(block: ChannelBlock, marketing: boolean): boolean {
  return block === 'all' || (marketing && block === 'marketing');
}

/**
 * THE SEND PATH'S DECISION, pure, from what the address lookup returned.
 *   any matching row refusing everything → 'opted_out'
 *   else, for a MARKETING message, any refusing marketing → 'opted_out_marketing'
 *   else 'send'
 * WHEN THE LOOKUP FAILED: a MARKETING message is refused ('marketing_check_failed') — nobody is owed
 * an offer, and sending one to someone who said no is the failure this exists to prevent. A SERVICE
 * message still SENDS, exactly as before step 3: dropping someone's quote or invoice because a
 * lookup blinked would be the worse harm, and the NotificationLog row records the send either way.
 */
export type SuppressionDecision = 'send' | 'opted_out' | 'opted_out_marketing' | 'marketing_check_failed';
export function suppressionDecision(
  lookup: { rows: PrefColumns[] } | { failed: true },
  send: { channel: PrefChannel; marketing: boolean },
): SuppressionDecision {
  if ('failed' in lookup) return send.marketing ? 'marketing_check_failed' : 'send';
  const blocks = lookup.rows.map((r) => channelBlock(r, send.channel));
  if (blocks.includes('all')) return 'opted_out';
  if (send.marketing && blocks.includes('marketing')) return 'opted_out_marketing';
  return 'send';
}
