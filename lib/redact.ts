/**
 * File: lib/redact.ts
 *
 * THE ONE PLACE A SENSITIVE FIELD IS TAKEN BACK OUT. A leaf — no imports at all, so the client
 * bundle can hold it and an error path can call it without dragging the database in.
 *
 * The V5C document reference is the reason this exists. It is not merely personal data: quoting it
 * is how keepership is transferred and how a vehicle is taxed online, so it is closer to a password
 * than to a registration. A trader legitimately holds it — that is what the logbook is for — but
 * holding it is the whole of the permission. It has no business in an audit diff a colleague reads,
 * in a 400 body that echoes the submitted form back, or in a log line.
 *
 * REDACTION IS A BACKSTOP, NOT THE DESIGN. The first defence is that no caller puts the value in a
 * diff; this catches the caller who does it anyway, and the caller who does it in a year. That is
 * why it is applied INSIDE the audit writers rather than asked of each of them.
 */

/**
 * Keys whose VALUE never leaves the database. Matched case-insensitively on the key alone, in both
 * the column spelling and the camelCase one, because a diff is built from whichever the writer had
 * to hand. A key list is a blacklist and would normally be the wrong shape — but the alternative
 * here is an allow-list of every field of every entity that may appear in any diff, which no one
 * would keep current. The mitigation is `redaction-gate`: the field must not be readable from any
 * API response either, so a miss here is not the only thing standing between it and a reader.
 */
export const REDACTED_KEYS: readonly string[] = ['v5c_reference', 'v5cReference'];

export const REDACTED_PLACEHOLDER = '[redacted]';

const redactedKey = (k: string) => REDACTED_KEYS.some((r) => r.toLowerCase() === k.toLowerCase());

/**
 * Walks ANY JSON-shaped value and replaces a redacted key's value wherever it sits — top level, in
 * `{ from, to }` pairs, inside arrays, nested at any depth. Depth matters: an audit diff is written
 * as `{ before: {...}, after: {...} }` about as often as it is written flat, and a redactor that
 * only checked the top level would be green on every test someone bothered to write and useless on
 * the shape actually stored.
 *
 * Cycles are cut rather than thrown on: this runs on the way to a write that must not fail because
 * a caller handed it something odd. Non-objects pass through untouched — a bare string cannot be
 * identified as a V5C without a key naming it, and guessing would redact registrations.
 */
export function redactDeep<T>(value: T, seen: WeakSet<object> = new WeakSet()): T {
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value as object)) return undefined as unknown as T;
  seen.add(value as object);

  if (Array.isArray(value)) return value.map((v) => redactDeep(v, seen)) as unknown as T;

  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = redactedKey(k) ? (v === null || v === undefined ? v : REDACTED_PLACEHOLDER) : redactDeep(v, seen);
  }
  return out as unknown as T;
}

/**
 * Does this value still carry a redacted key with a real value? For the gate, and for any caller
 * that wants to assert rather than trust. Returns the PATHS, because "something leaked" sends the
 * reader hunting and "diff.after.v5c_reference leaked" does not.
 */
export function redactionLeaks(value: unknown, path = '', seen: WeakSet<object> = new WeakSet()): string[] {
  if (value === null || typeof value !== 'object') return [];
  if (seen.has(value as object)) return [];
  seen.add(value as object);
  if (Array.isArray(value)) return value.flatMap((v, i) => redactionLeaks(v, `${path}[${i}]`, seen));

  const leaks: string[] = [];
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    const here = path ? `${path}.${k}` : k;
    if (redactedKey(k)) {
      if (v !== null && v !== undefined && v !== REDACTED_PLACEHOLDER) leaks.push(here);
    } else leaks.push(...redactionLeaks(v, here, seen));
  }
  return leaks;
}
