/**
 * File: lib/reseller-interest.ts
 * THE RULES for a reseller expression of interest. Pure, importing nothing — so every refusal and
 * every outcome is provable without a database, a mail provider, or a served page.
 *
 * ── TWO INDEPENDENT THINGS HAPPEN, AND NEITHER MAY TAKE THE OTHER DOWN ──────────────────────────
 * An enquiry is STORED and a notification is EMAILED (owner, 2026-09-12). Before the store existed a
 * Resend failure lost the enquiry outright, with no record anywhere and no number to read back.
 *
 * So the two run separately and each failure is caught on its own:
 *   stored + emailed  → the ordinary case.
 *   stored, not sent  → we HAVE the enquiry and nobody was told. The person is told we have it,
 *                       because for them that is true; email_delivered=false is the flag to look at.
 *   sent, not stored  → somebody was told, so the enquiry is not lost. Same answer to the person.
 *   neither           → the only case where the person must be asked to do something else, and the
 *                       only one that may return an error. Silence here would be the old defect.
 *
 * A person is never shown a failure for something that did succeed, and never shown success for
 * something that vanished. Three send silences are three different actions; so are these.
 */

/** Field limits, shared by the endpoint and the gate so neither drifts from the other. */
export const LIMITS = { name: 100, company: 200, area: 200, email: 200, phone: 50, message: 5000 } as const;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export type InterestInput = {
  name?: unknown; company?: unknown; area?: unknown; email?: unknown; phone?: unknown; message?: unknown;
};
export type InterestFields = { name: string; company: string; area: string; email: string; phone: string; message: string };

/**
 * VALIDATION, AND IT NAMES THE FIELD. "One of the fields is too long" made the person hunt; the
 * limit that was exceeded is known here, so it is said.
 */
export function validateInterest(b: InterestInput): { ok: true; fields: InterestFields } | { ok: false; message: string } {
  const str = (v: unknown) => String(v ?? '').trim();
  const fields: InterestFields = {
    name: str(b.name), company: str(b.company), area: str(b.area),
    email: str(b.email), phone: str(b.phone), message: str(b.message),
  };
  if (!fields.name) return { ok: false, message: 'Please enter your name.' };
  if (!EMAIL_RE.test(fields.email)) return { ok: false, message: 'Please enter a valid email address.' };
  for (const k of ['name', 'company', 'area', 'email', 'phone', 'message'] as const) {
    if (fields[k].length > LIMITS[k]) return { ok: false, message: `That ${k === 'message' ? 'message' : k} is too long — please shorten it.` };
  }
  return { ok: true, fields };
}

export type InterestOutcome = { status: number; ok: boolean; message: string };

/**
 * WHAT THE PERSON IS TOLD, given what actually happened. `fallbackPhone` is only ever used in the
 * one case where nothing landed — a number in a success message reads as "ring us anyway".
 */
export function interestOutcome(done: { stored: boolean; emailed: boolean }, fallbackPhone: string): InterestOutcome {
  if (done.stored || done.emailed) {
    return { status: 200, ok: true, message: 'Thanks — we have your details and we’ll be in touch about becoming a reseller.' };
  }
  return { status: 502, ok: false, message: `Sorry — we couldn’t record that just now. Please call us on ${fallbackPhone} and we’ll take your details.` };
}

/**
 * SHOULD THIS ENQUIRY'S PERSONAL DATA BE GONE? The same rule and the same clock as a prospect's —
 * lib/prospects owns the period and the reasons; this only applies them to an enquiry's own date, so
 * there is one retention period in the codebase rather than two that can drift apart.
 */
export function interestPastRetention(createdAt: Date, now: Date, retentionMonths: number): boolean {
  const cutoff = new Date(now);
  cutoff.setUTCMonth(cutoff.getUTCMonth() - retentionMonths);
  return createdAt.getTime() < cutoff.getTime();
}
