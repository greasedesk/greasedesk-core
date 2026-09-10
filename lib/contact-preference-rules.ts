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
