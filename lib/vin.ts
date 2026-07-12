/**
 * File: lib/vin.ts
 * THE VIN validation chokepoint (isomorphic — the phone gate, the server, and the audit all call
 * this one function). ISO 3779 rules: exactly 17 characters, uppercase, never I/O/Q, and the
 * position-9 check digit must verify (transliterated weighted sum mod 11; 10 renders as 'X').
 * Confirmed against real vehicles before adoption (ruling 2026-07-13) — a VIN that fails here is
 * a read error or a typo, never saved.
 */
const TRANSLIT: Record<string, number> = {
  A: 1, B: 2, C: 3, D: 4, E: 5, F: 6, G: 7, H: 8,
  J: 1, K: 2, L: 3, M: 4, N: 5, P: 7, R: 9,
  S: 2, T: 3, U: 4, V: 5, W: 6, X: 7, Y: 8, Z: 9,
  '0': 0, '1': 1, '2': 2, '3': 3, '4': 4, '5': 5, '6': 6, '7': 7, '8': 8, '9': 9,
};
const WEIGHTS = [8, 7, 6, 5, 4, 3, 2, 10, 0, 9, 8, 7, 6, 5, 4, 3, 2];

export const VIN_SHAPE_RE = /^[A-HJ-NPR-Z0-9]{17}$/; // 17 chars, no I/O/Q

/** Normalise for validation: trim, strip internal whitespace, uppercase. */
export const normaliseVinInput = (v: string): string => (v || '').replace(/\s+/g, '').toUpperCase();

/** The ISO 3779 position-9 check digit for a 17-char candidate (shape must already hold). */
export function vinCheckDigit(vin: string): string {
  let sum = 0;
  for (let i = 0; i < 17; i++) sum += (TRANSLIT[vin[i]] ?? 0) * WEIGHTS[i];
  const r = sum % 11;
  return r === 10 ? 'X' : String(r);
}

/** Full gate: shape AND check digit. */
export function isValidVin(raw: string): boolean {
  const vin = normaliseVinInput(raw);
  if (!VIN_SHAPE_RE.test(vin)) return false;
  return vin[8] === vinCheckDigit(vin);
}
