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

/**
 * ── IS IT PLAUSIBLY A UK MOBILE? (owner, 2026-11-01: the field is now REQUIRED) ─────────────────
 * The number stopped being optional, which changes what a wrong one costs. An optional field left
 * blank was an absence and said so; a required field holding '12345678' is an ANSWER, and the
 * onboarding step that offers the number back, and anybody who later rings it, both read it as one.
 *
 * PLAUSIBLE IS THE WHOLE CLAIM, AND THE NAME SAYS SO. This is the shape of a UK mobile: 07 and nine
 * more digits, or the same number written internationally. It is NOT evidence that the number
 * exists, belongs to them, or can receive a message — the SMS step still proves that, and nothing
 * here writes phone_verified_at. A shape check that called itself validation would be a plausible
 * wrong name for a weaker fact.
 *
 * WHAT IT REFUSES, and why each is refused rather than reshaped:
 *   • blank — the field is required, and "they left it empty" is the one case with a different
 *     sentence, because the fix is different: type something, rather than correct something.
 *   • a landline (01…, 02…, 03…) — a mobile is asked for because we send a code to it. A landline
 *     is a real number that cannot do the one thing this field is for, so accepting it would mean
 *     the garage stalls at a step it can never pass.
 *   • 07 with the wrong number of digits, and anything non-GB. We admit GB only (one allow-list in
 *     the single country writer), so a +353 number is a number we cannot act on today.
 *
 * It returns the SENTENCE, not a boolean, so the page and the route say the same words — the form
 * shows this and the endpoint repeats it, and neither owns a second copy of the rule.
 */
/** One sentence, two refusals: a number that is the wrong shape gets the same help either way. */
export const UK_MOBILE_REFUSAL = 'Enter a UK mobile number, starting 07 — for example 07700 900123.';

export function refuseSignupMobile(raw: unknown): string | null {
  const cleaned = normaliseSignupMobile(raw);
  // BLANK IS ITS OWN SENTENCE. normaliseSignupMobile also returns null for 1-6 digits, which is why
  // the emptiness is tested on the INPUT rather than inferred from its null.
  if (typeof raw !== 'string' || raw.trim() === '') return 'Enter your mobile number so we can help you get set up.';
  if (cleaned === null) return UK_MOBILE_REFUSAL;
  return plausibleUkMobile(cleaned) ? null : UK_MOBILE_REFUSAL;
}

/**
 * THE SHAPE, as a predicate, so a gate can walk a table of numbers without a page.
 * `07700900123`, `+44 7700 900123`, `447700900123`, `0044 7700 900123` are the same number.
 */
export function plausibleUkMobile(raw: string | null | undefined): boolean {
  const trimmed = String(raw ?? '').trim();
  if (trimmed === '') return false;
  let d = trimmed.replace(/\D/g, '');
  // 00 is the international prefix written out; a leading + is already gone with the non-digits.
  if (d.startsWith('00')) d = d.slice(2);
  if (/^07\d{9}$/.test(d)) return true;         // national form
  return /^447\d{9}$/.test(d);                  // +44 / 44, with the trunk 0 dropped
}
