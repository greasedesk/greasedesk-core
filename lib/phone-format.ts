/**
 * File: lib/phone-format.ts
 *
 * A PHONE NUMBER, READABLE. A leaf: no imports, so an email template and a page can both take it.
 *
 * ── IT FORMATS OR IT GIVES BACK WHAT IT WAS GIVEN ───────────────────────────────────────────────
 * `07397387332` in an alert is a number you have to transcribe by eye before you can dial it, and
 * the no-checkout alert exists precisely so somebody can ring the garage. So GB numbers are grouped
 * the way they are written: `+44 7397 387332`.
 *
 * What it will NOT do is guess. A number it does not recognise comes back unchanged — never
 * reshaped, never prefixed with a country code it was not given. A formatter that invents a +44 in
 * front of a foreign number produces something that looks dialable and is not, and the whole point
 * of showing the number is that somebody acts on it.
 */

/** Digits only, and whether the original asked for international. */
const parts = (raw: string) => ({ digits: raw.replace(/\D/g, ''), plus: raw.trim().startsWith('+') });

/**
 * GB mobile and landline grouping; anything else is returned as given.
 * `07397387332` / `+447397387332` / `447397387332` → `+44 7397 387332`.
 */
export function formatPhone(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  const { digits, plus } = parts(trimmed);

  // 07… national form, 11 digits.
  if (!plus && /^0[1-9]\d{9}$/.test(digits)) return `+44 ${digits.slice(1, 5)} ${digits.slice(5)}`;
  // 44… with or without the +, 12 digits.
  if (/^44[1-9]\d{9}$/.test(digits)) return `+44 ${digits.slice(2, 6)} ${digits.slice(6)}`;
  // Recognised as nothing in particular: hand it back exactly as it arrived.
  return trimmed;
}

/**
 * A MOBILE TYPED AT SIGNUP, ON ITS WAY TO THE DATABASE — a different job from formatPhone.
 *
 * STORED, NOT PRESENTED, so this normalises for storage and refuses for nonsense; formatPhone
 * groups for a human reading it. Keeping them apart matters because the two want opposite things:
 * a display formatter must never lose what it was given, and a column must never accept a control
 * character or 400 characters of paste.
 *
 * ── WHAT IT REFUSES ─────────────────────────────────────────────────────────────────────────────
 * Blank → null, so an untouched optional field is an absence and not an empty string pretending to
 * be an answer. Control characters are stripped (a NUL makes Postgres throw 22021, the same reason
 * lib/signup-source strips them). Anything with fewer than 7 digits is NOT a phone number and is
 * refused as null rather than stored: a column holding "ask me later" is worse than an empty one,
 * because the alert built on it will print it to somebody about to dial.
 *
 * It does NOT reshape or add a country code. The field is optional and free-form, people type
 * whatever they type, and a number we rewrote is a number we cannot show back to them unchanged.
 */
export const SIGNUP_MOBILE_MAX = 32;

export function normaliseSignupMobile(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const cleaned = raw.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, SIGNUP_MOBILE_MAX);
  if (cleaned === '') return null;
  if ((cleaned.match(/\d/g) ?? []).length < 7) return null;
  return cleaned;
}
