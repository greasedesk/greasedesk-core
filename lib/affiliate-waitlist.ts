/**
 * File: lib/affiliate-waitlist.ts
 * THE RULES for "the programme isn't open yet — tell me when it is".
 *
 * PURE, importing nothing, for the same two reasons lib/reseller-interest is: every refusal is
 * provable without a database or a served page, AND the public page imports the limits and the
 * audience list at module scope. A module that reached prisma could not be imported there without
 * shipping the Prisma client to the browser.
 *
 * ── WHAT THIS IS NOT ───────────────────────────────────────────────────────────────────────────
 * Not a signup, not an account, not an affiliate. Nothing here creates a Rep row, mints a code or
 * accepts any terms: a waiting-list entry is an email address and the day it was left. When joining
 * opens, these people get told; they then sign up like anybody else. Keeping the two apart is what
 * stops a waiting list quietly becoming a list of affiliates who never agreed to anything.
 *
 * ── NOT ResellerEnquiry EITHER ─────────────────────────────────────────────────────────────────
 * That table holds expressions of interest in the RESELLER programme, with a name, a round, an area
 * and a message. Two different populations under one table would make every count ambiguous and put
 * one programme's people in the other's list. One table each.
 */

/** Field limits, shared by the endpoint, the page and the gate so none drifts from the others. */
export const WAITLIST_LIMITS = { email: 200 } as const;

/**
 * WHICH SORT OF PERSON IS WAITING — asked, never inferred.
 *
 * The page speaks to two audiences and the owner wants to know who is actually waiting, so the form
 * asks in one optional radio pair. Inferring it from which section's button they pressed would be a
 * guess recorded as a fact; asking costs one line and is true. OPTIONAL, so NULL is a real answer
 * ("they did not say"), distinct from either value and never defaulted to the commoner one.
 */
export const WAITLIST_AUDIENCES = ['trade', 'creator'] as const;
export type WaitlistAudience = typeof WAITLIST_AUDIENCES[number];

export type WaitlistInput = { email?: unknown; audience?: unknown };
export type WaitlistFields = { email: string; audience: WaitlistAudience | null };

// Deliberately the same shape the rest of the codebase uses, rather than a stricter invention: a
// validator that rejects a legitimate address is worse than one that accepts an undeliverable one,
// because the second is discovered by sending and the first is never discovered at all.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Validate, and NAME what was wrong. "Check your details" makes a person hunt; there is only one
 * field here, so there is no excuse for being vague about it.
 */
export function validateWaitlist(b: WaitlistInput): { ok: true; fields: WaitlistFields } | { ok: false; message: string } {
  const email = String(b.email ?? '').trim();
  if (!email) return { ok: false, message: 'Please give us an email address.' };
  if (email.length > WAITLIST_LIMITS.email) return { ok: false, message: `That email is too long (limit ${WAITLIST_LIMITS.email}).` };
  if (!EMAIL_RE.test(email)) return { ok: false, message: 'That email address doesn’t look right.' };

  // THREE STATES, NOT TWO. Absent or empty = they did not say, which is stored as NULL. A value we
  // do not recognise is a REFUSAL rather than a silent NULL: it means the form and this list have
  // drifted apart, and turning that into "they did not say" would hide the drift for ever.
  const raw = b.audience === undefined || b.audience === null || b.audience === '' ? null : String(b.audience);
  if (raw !== null && !(WAITLIST_AUDIENCES as readonly string[]).includes(raw)) {
    return { ok: false, message: 'Please choose one of the options, or leave it blank.' };
  }

  // LOWER-CASED FOR STORAGE, because the unique index decides who is already waiting and
  // "Sam@x.com" and "sam@x.com" are one person with one place in the queue. Postgres uniqueness is
  // case-sensitive, so folding here is the only thing that makes that true.
  return { ok: true, fields: { email: email.toLowerCase(), audience: (raw as WaitlistAudience | null) } };
}
