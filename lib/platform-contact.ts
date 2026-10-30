/**
 * File: lib/platform-contact.ts
 * THE ADDRESSES GREASEDESK READS ITS OWN POST AT — the one default, and the owner's chosen list.
 *
 * Two things now write to us rather than to a customer: the public contact form, and the owner's
 * operator alerts (lib/operator-alerts). They had one address between them and it was a literal
 * inside pages/api/contact.ts — so the second reader would have been a second copy of the same
 * string, and the day it changed one of them would have gone on delivering to the old one.
 *
 * NOT lib/company-info, which is client-imported: an address in that file ships to the browser and
 * is then a published address, which is exactly the rule the marketing surface keeps (form-only
 * contact, no public email). This module is server-only by convention and by use — nothing that
 * renders imports it.
 *
 * ENV FIRST, so it can be moved without a deploy; the literal is the fallback and the fallback is
 * deliberate. An unset variable must not mean "nobody is told", which is what returning null would
 * have meant at every one of these call sites.
 */

/** The fallback, and the address this has always delivered to. */
export const PLATFORM_CONTACT_FALLBACK = 'hugh@greasedesk.com';

/**
 * Where a message to GreaseDesk itself goes. Lower-cased and trimmed, because it is compared
 * against stored recipients: one side writing `Hugh@…` and the other matching `hugh@…` is the
 * silent one-sided transformation that makes an idempotency check stop recognising its own rows.
 */
export function platformContactTo(): string {
  const v = (process.env.CONTACT_FORM_TO ?? '').trim().toLowerCase();
  return v || PLATFORM_CONTACT_FALLBACK;
}

// ── THE OWNER'S ALERT RECIPIENTS ───────────────────────────────────────────────────────────────
//
// THE CLEAN AND THE RESOLUTION LIVE HERE, IN A MODULE THAT IMPORTS NOTHING, and that is not
// tidiness. They were first written in lib/operator-alerts, which lib/programme-settings then had
// to import to validate a save — and that closed a runtime import cycle:
//
//   notification-templates → programme-settings → operator-alerts → notify → notification-templates
//
// A cycle like that usually works and occasionally hands a module a half-initialised neighbour.
// Putting the two rules in a leaf breaks it at the only edge that was new.

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const MAX_ALERT_RECIPIENTS = 10;

/**
 * Clean what a person typed into a list that can be stored. One address per line or comma, trimmed,
 * lower-cased, de-duplicated. THE ONLY WRITER'S validator, which is why the column has no CHECK.
 *
 * LOWER-CASED, deliberately: the stored list is matched against NotificationLog.recipient to decide
 * whether an alert has already been sent. One side storing `Hugh@…` while the other matches
 * `hugh@…` is a one-sided transformation, and the symptom is an alert that sends every hour.
 */
export function refuseAlertEmails(raw: unknown): { ok: true; emails: string[] } | { ok: false; message: string } {
  if (raw == null) return { ok: true, emails: [] };
  const parts = (Array.isArray(raw) ? raw.map(String) : String(raw).split(/[\n,;]+/))
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  const bad = parts.filter((p) => !EMAIL_RE.test(p));
  if (bad.length) return { ok: false, message: `Not an email address: ${bad.slice(0, 3).join(', ')}` };
  const unique = [...new Set(parts)];
  if (unique.length > MAX_ALERT_RECIPIENTS) return { ok: false, message: `At most ${MAX_ALERT_RECIPIENTS} addresses.` };
  return { ok: true, emails: unique };
}

/**
 * Who the alerts go to. An EMPTY list is "nobody has chosen" and resolves to the one platform
 * contact address — never to nobody. Returning an empty array here would make every alert a
 * `no recipient` skip, which is a silence that looks like a decision.
 */
export function alertRecipients(settings: { alert_emails?: string[] | null } | null | undefined): string[] {
  const chosen = (settings?.alert_emails ?? []).map((s) => s.trim().toLowerCase()).filter(Boolean);
  return chosen.length ? [...new Set(chosen)] : [platformContactTo()];
}
