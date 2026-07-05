/**
 * File: lib/quick-validate.ts
 * Pure validators for the diary quick-create form. Non-technical garage users must never hit cryptic
 * failures: required fields BLOCK; optional fields WARN (messy real data — warn, allow, fix later);
 * EXCEPT mileage overflow, which BLOCKS (7+ digits overflow the INT column → the DB write fails).
 * Each function returns an i18n KEY (or null) under diary:create.warn.* — the UI renders the text.
 */
import { normalizeVin } from '@/lib/vehicle-identity';

/** Strip spaces for phone comparison/storage. */
export const normalizePhone = (raw?: string | null): string => (raw || '').replace(/\s+/g, '');

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

/** Phone: WARN only. Plausible UK = 10–11 digits, or +44 followed by 9–10 digits. */
export function phoneWarn(raw?: string | null): 'phone' | null {
  const s = normalizePhone(raw);
  if (!s) return null;
  if (/^\+44\d{9,10}$/.test(s)) return null;
  return /^\d{10,11}$/.test(s) ? null : 'phone';
}

/** Email: WARN only. Loose x@y.z shape. */
export function emailWarn(raw?: string | null): 'email' | null {
  const s = (raw || '').trim();
  if (!s) return null;
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s) ? null : 'email';
}
