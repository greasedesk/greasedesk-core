/**
 * File: lib/sign-in-failure.ts
 * WHY A SIGN-IN FAILED, AS A CODE — and the one place that decides what a person is told.
 *
 * ── THE INCIDENT THIS EXISTS FOR (2026-10-30) ──────────────────────────────────────────────────
 * The production database hit its Neon quota and refused every connection. authorize() reads the
 * user row as its first act, so the throw propagated; the login page turned every non-2FA failure
 * into `?error=InvalidCredentials`; and two garages spent a morning being told their password was
 * wrong by a page that had no idea what had happened. Nothing was wrong with their passwords.
 *
 * The comment above that line already said it, about a different cause: a 2FA refusal "must not be
 * reported as one — bouncing to 'invalid email or password' would send someone resetting a password
 * that is correct." Exactly the same sentence applies to an outage, and nobody extended it.
 *
 * ── A LEAF MODULE, WITH NO IMPORTS ─────────────────────────────────────────────────────────────
 * Both the server (pages/api/auth/[...nextauth]) and the CLIENT (pages/admin/login) read it. A
 * module-scope import of anything that reaches lib/db from a page ships Prisma to the browser and
 * kills every bit of client JavaScript on it — so this imports nothing, for ever.
 *
 * ── AND IT LEAKS NOTHING ABOUT AN ACCOUNT ──────────────────────────────────────────────────────
 * `system_unavailable` is decided ONLY by a lookup THROWING, never by what a lookup returned. It is
 * the same answer whether the email exists, does not exist, is suspended or is archived, because at
 * the moment it is raised nothing has been learned about any of those. That ordering is the whole
 * guard: a message chosen after a result is examined would be a probe for valid addresses.
 */

/** The marker carried in the thrown Error's message, which is all next-auth passes back. */
export const SYSTEM_UNAVAILABLE = 'SYSTEM_UNAVAILABLE';

/** The `?error=` code the login page redirects with, and reads back. */
export const SYSTEM_UNAVAILABLE_CODE = 'SystemUnavailable';
export const INVALID_CREDENTIALS_CODE = 'InvalidCredentials';

export type SignInFailure =
  | 'two_factor_locked'
  | 'two_factor_required'
  | 'system_unavailable'
  | 'invalid_credentials';

/**
 * THE ERROR THE PROVIDER THROWS when a lookup it needs could not be made.
 *
 * The cause is NOT put in the message. next-auth passes the message to the browser, and a Prisma
 * initialisation error carries the connection target in its text — so the marker travels and the
 * detail stays on the server, where the console.error below puts it.
 */
export function systemUnavailable(): Error {
  const e = new Error(SYSTEM_UNAVAILABLE);
  e.name = 'SystemUnavailable';
  return e;
}

/**
 * WHICH FAILURE THIS IS, from the message next-auth handed back.
 *
 * ORDER MATTERS AND IS NOT ALPHABETICAL: the two 2FA cases first, because they were already
 * special-cased and must stay so; then the outage; and `invalid_credentials` LAST, as the fallback —
 * which is the shape that caused the incident and is now the only branch that guesses.
 */
export function classifySignInError(message: string | null | undefined): SignInFailure {
  const m = String(message ?? '');
  if (m.includes('TWO_FACTOR_LOCKED')) return 'two_factor_locked';
  if (m.includes('TWO_FACTOR_REQUIRED')) return 'two_factor_required';
  if (m.includes(SYSTEM_UNAVAILABLE)) return 'system_unavailable';
  return 'invalid_credentials';
}

/**
 * THE OWNER'S WORDS, verbatim (2026-10-30). Two sentences, and the second is the one that matters:
 * it tells somebody not to go and change a password that was never the problem.
 */
export const SYSTEM_UNAVAILABLE_MESSAGE =
  'We can’t reach our systems just now. This isn’t your password — please try again in a few minutes.';

/** What a person is shown for each failure. One map, so no surface invents its own sentence. */
export const SIGN_IN_MESSAGE: Record<SignInFailure, string> = {
  two_factor_locked: 'Too many incorrect codes. Wait 15 minutes and try again.',
  two_factor_required: 'That code didn’t match. Try the current one from your app.',
  system_unavailable: SYSTEM_UNAVAILABLE_MESSAGE,
  invalid_credentials: 'Invalid email or password.',
};
