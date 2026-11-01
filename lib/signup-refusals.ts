/**
 * File: lib/signup-refusals.ts
 * WHAT A PERSON READS WHEN A SIGNUP WILL NOT GO THROUGH — one sentence per situation, and never
 * the database's own words.
 *
 * ── THE INCIDENT (owner, 2026-11-01) ───────────────────────────────────────────────────────────
 * A real signup through a real affiliate link answered, on the screen, in the box a customer reads:
 *
 *     Database error: P2002. Check your schema constraints. [catch]
 *
 * Three faults in one sentence. It named an internal error code; it instructed the READER to check
 * a schema they have never seen; and it said nothing about what to do. Underneath it the actual
 * fact was ordinary and sayable: that email address already belongs to a garage.
 *
 * The catch block had a second branch that was worse — `err.message` straight to the browser for
 * anything that was not a Prisma error — which is a disclosure path, not a wording problem.
 *
 * ── WHY THE MAPPING LIVES HERE AND NOT IN THE ROUTE ────────────────────────────────────────────
 * Two callers need the same sentences: the endpoint, which refuses, and /register, which has its
 * own failure modes (an unparseable body, a dead fetch) and must not invent its own words for
 * them. A sentence written twice drifts, and the drift shows up as a person being told two
 * different things about one problem.
 *
 * ── IT MUST NOT IMPORT @prisma/client, AND THAT IS NOT AN AESTHETIC CHOICE ─────────────────────
 * /register imports this module, so anything it imports ships to the browser. `Prisma` at module
 * scope would drag the client in and break the page (see [[client-bundle-leak]]). So a Prisma error
 * is recognised by its SHAPE — a `code` of 'P2002' and a `meta.target` — which is all the
 * classification needs and is exactly what the thrown object carries.
 */
import { COMPANY } from '@/lib/company-info';

/**
 * THE ONE SENTENCE FOR "WE DO NOT KNOW WHAT WENT WRONG". It says what happened, offers the two
 * things that might work, and gives the number — read from company-info, because the number on a
 * refusal has to be the number on the site, and a typed literal is how those two part company.
 */
export const SIGNUP_GENERIC =
  `Something went wrong, please try again or call us on ${COMPANY.phone}.`;

/** The conflicts we can name. A code, not a sentence, at the call sites. */
export type SignupConflictCode = 'user_email' | 'billing_email' | 'mobile';

/**
 * ── THE REGISTRY, AND THE ORDER IS LOAD-BEARING ────────────────────────────────────────────────
 * A P2002 arrives carrying either a constraint name ('Group_billing_email_key') or a column list
 * (['billing_email']) depending on the connector, so matching is done on a lowercased substring of
 * whichever it is. 'billing_email' CONTAINS 'email', so the billing row must be tested first or
 * every garage-level clash would be answered with "reset your password" — advice that leads
 * nowhere, because there is no account to reset.
 *
 * ── THE TWO EMAIL CASES ARE DIFFERENT SITUATIONS AND GET DIFFERENT ADVICE ──────────────────────
 * `User.email` means a person can sign in with it. `Group.billing_email` means a GARAGE holds it
 * and there may be no account on it at all — which is exactly the case the owner hit: zero User
 * rows for that address, one Group. Telling him to reset his password would have been a dead end.
 *
 * ── THE MOBILE ROW IS REGISTERED AND UNREACHABLE, DELIBERATELY ─────────────────────────────────
 * The owner decided on 2026-11-01 that a mobile stays NON-UNIQUE: a couple running a garage share
 * one, and the field is there to help us set them up, not to identify anybody. So there is no
 * unique index on phone_e164 and nothing can raise this conflict today. The sentence is registered
 * anyway, because the decision could be revisited and the words should not have to be invented
 * under pressure — and came-via-gate asserts BOTH halves: that the registry answers it plainly,
 * and that no such index exists. If somebody adds one, that clause goes red and names this
 * decision, which is the alarm you want rather than a quiet change of policy.
 */
const CONFLICTS: ReadonlyArray<{ code: SignupConflictCode; match: string; message: string }> = [
  {
    code: 'billing_email',
    match: 'billing_email',
    message: 'That email address is already in use for an existing GreaseDesk garage. If it is yours, '
      + `sign in with the account you normally use — or call us on ${COMPANY.phone} and we will sort it out.`,
  },
  {
    code: 'user_email',
    match: 'email',
    message: 'An account with this email address already exists. Sign in instead, or reset your password '
      + 'if you have forgotten it.',
  },
  {
    code: 'mobile',
    match: 'phone_e164',
    message: 'That mobile number is already in use on another account.',
  },
];

/** The sentence for a conflict we found ourselves, before anything was attempted. */
export function conflictMessage(code: SignupConflictCode): string {
  const row = CONFLICTS.find((c) => c.code === code);
  // Unreachable while SignupConflictCode and CONFLICTS agree; a missing row must not become a blank
  // message on a screen, so it falls back to the sentence that always says something useful.
  return row ? row.message : SIGNUP_GENERIC;
}

export type SignupRefusal = {
  /** 409 for a conflict, 500 for anything we could not name. */
  status: number;
  /** For the log and for `where` — never rendered. */
  code: SignupConflictCode | 'conflict_unknown' | 'unknown';
  /** The only string that may reach a person. */
  message: string;
};

/**
 * THE CLASSIFIER. THREE OUTCOMES, NOT TWO: a conflict we can name, a conflict we cannot name, and
 * not a conflict at all. The middle one matters — a unique index nobody mapped is still a clash the
 * person could resolve, but we must not guess WHICH field it was and send them to change the wrong
 * one. It gets the generic sentence and a 409, so the status is honest even when the words cannot be.
 *
 * `err` is unknown on purpose: this is a catch block's argument, and the one thing certain about it
 * is that nothing is certain about it.
 */
export function signupRefusal(err: unknown): SignupRefusal {
  const shape = (err ?? null) as { code?: unknown; meta?: { target?: unknown } } | null;
  if (shape && shape.code === 'P2002') {
    const target = targetText(shape.meta?.target);
    for (const c of CONFLICTS) {
      if (target.includes(c.match)) return { status: 409, code: c.code, message: c.message };
    }
    return { status: 409, code: 'conflict_unknown', message: SIGNUP_GENERIC };
  }
  return { status: 500, code: 'unknown', message: SIGNUP_GENERIC };
}

/** Whichever shape the connector gave us, as one lowercased haystack. '' when it gave us nothing. */
function targetText(target: unknown): string {
  if (Array.isArray(target)) return target.join(',').toLowerCase();
  if (typeof target === 'string') return target.toLowerCase();
  return '';
}

/**
 * ── WHAT WE SAY WHEN IT WORKED, WHICH IS NOT ALWAYS THE SAME SENTENCE ──────────────────────────
 * The garage is committed before the verification email is even attempted. If the token or the send
 * fails, "check your email" is a false instruction: they would wait for a message that is not
 * coming, try again, and be told the address is taken. So the second sentence names the number
 * instead — the account exists either way, and that is the part they need to be sure of.
 */
export function signupCreatedMessage(verifySent: boolean): string {
  return verifySent
    ? 'Account created. Please check your email to verify.'
    : 'Account created — but we could not send your verification email just now. '
      + `Call us on ${COMPANY.phone} and we will verify it for you.`;
}
