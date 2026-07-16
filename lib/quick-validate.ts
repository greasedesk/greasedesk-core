/**
 * File: lib/quick-validate.ts
 * Pure validators for the diary quick-create form. Non-technical garage users must never hit cryptic
 * failures: required fields BLOCK; optional fields WARN (messy real data — warn, allow, fix later);
 * EXCEPT mileage overflow, which BLOCKS (7+ digits overflow the INT column → the DB write fails).
 * Each function returns an i18n KEY (or null) under diary:create.warn.* — the UI renders the text.
 */
import { normalizeVin } from '@/lib/vehicle-identity';

/**
 * THE canonical phone form for storage + dialling (one place; every phone field normalises through
 * here). Strip ALL formatting (spaces, hyphens, brackets, dots, letters), keep the digits and a
 * single leading '+' for international numbers, and fold a 00 international prefix to '+'. Country-
 * AGNOSTIC — no trunk-0 guessing (07…/+44…/+353… all stay valid and dialable). It's a consistent,
 * tel:-dialable form, not strict E.164. Feeds a tel: link, never a billing decision.
 *   "+44 (0)7911 123 456" → "+4407911123456"   "0044 7911 123456" → "+447911123456"
 *   "07911 123456" → "07911123456"             "+353 87 123 4567" → "+353871234567"
 */
export const normalizePhone = (raw?: string | null): string => {
  const t = (raw || '').trim();
  if (!t) return '';
  const intl = /^\+|^00/.test(t);          // written as an international number
  let digits = t.replace(/\D/g, '');       // digits only
  if (intl && digits.startsWith('00')) digits = digits.slice(2); // 0044… → 44…
  return intl ? '+' + digits : digits;
};

/** Mileage: BLOCKS. null = ok/empty; 'nan' = not a whole number; 'overflow' = 7+ digits (phone?). */
export function mileageError(raw?: string | null): 'nan' | 'overflow' | null {
  const s = (raw || '').trim();
  if (!s) return null;
  if (!/^\d+$/.test(s)) return 'nan';
  if (Number(s) > 999999) return 'overflow';
  return null;
}

/** VIN: WARN only. A VIN is exactly 17 alphanumerics excluding I/O/Q. null = ok/empty, 'vin' = warn. */
export function vinWarn(raw?: string | null): 'vin' | null {
  const v = normalizeVin(raw);
  if (!v) return null;
  return v.length === 17 && !/[IOQ]/.test(v) ? null : 'vin';
}

/**
 * Phone: WARN only, country-AGNOSTIC. Normalise first, then reject ONLY what's obviously not a phone
 * number at all — a plausible number is 7–15 digits (E.164 max is 15), with or without a leading '+'.
 * Accepts +44 / 0044 / 0-prefixed / +353 / any international form as equivalent. Biased toward
 * accepting: a rejected valid number blocks the user; a stored imperfect one costs only a re-key.
 */
export function phoneWarn(raw?: string | null): 'phone' | null {
  const s = normalizePhone(raw);
  if (!s) return null;
  const digits = s.replace(/\D/g, '');
  return digits.length >= 7 && digits.length <= 15 ? null : 'phone';
}

/** Email: WARN only. Loose x@y.z shape. */
export function emailWarn(raw?: string | null): 'email' | null {
  const s = (raw || '').trim();
  if (!s) return null;
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s) ? null : 'email';
}
