/**
 * File: lib/affiliate-join.ts
 * THE RULES for becoming an affiliate, and the minting of the code.
 *
 * PURE except for the one function that has to look in the database to answer "is this code taken".
 * Everything a refusal depends on is decidable without a server, a page or a provider, so every
 * refusal below is provable on its own.
 *
 * ── WHAT A SIGNUP IS, AND IS NOT ───────────────────────────────────────────────────────────────
 * It creates a Rep row with party_type 'affiliate' and terms_accepted_at set, because the form
 * states the terms and the button accepts them. It does NOT verify anything by itself: the mobile
 * is proved by a code typed back (lib/phone-verification), and the email by the link we send
 * afterwards being followed. "Instant approval" means there is no human in the loop — not that
 * nothing is checked.
 *
 * ── ONE AFFILIATE PER PERSON, THE ROW REUSED BY EMAIL (owner, 2026-10-29) ──────────────────────
 * Rep.email is @unique across reps AND affiliates, so an email that already belongs to somebody is
 * not a second account. Three different cases hide behind that one constraint and they must not be
 * collapsed:
 *   an affiliate who has not finished  → the SAME row, carried on (they lost the tab, the SMS
 *                                        did not arrive, they came back the next day);
 *   an affiliate who is already done   → nothing to do; they are sent to their link;
 *   a RESELLER's email                 → refused, and said plainly. A rep is a different
 *                                        arrangement with a different agreement, and silently
 *                                        turning one into the other would be the worst of the three.
 */
type Db = any; // a PrismaClient or an interactive-transaction client

export const JOIN_LIMITS = { name: 100, email: 200, phone: 50, social: 100 } as const;

/**
 * THE CODE'S ALPHABET, and why it is not A–Z0–9.
 *
 * A code is read off a card, a van, a video description or a bio link and retyped by somebody who
 * never saw it written down. O/0 and I/1/l are the pairs people get wrong, so they are not in it;
 * what is left is unambiguous in any font. UPPER CASE only, which is how it is printed — matching
 * folds the case anyway (lib/attribution), so the casing is a presentation choice, not a key.
 */
export const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
/** Eight characters out of a 32-letter alphabet: 32^8, about a thousand billion. Long enough that
 *  guessing is pointless and short enough to say over a counter. */
export const CODE_LENGTH = 8;

/**
 * One candidate.
 *
 * ── globalThis.crypto, NOT node:crypto, AND THAT IS NOT A STYLE CHOICE ─────────────────────────
 * The signup page imports JOIN_LIMITS from this module, so it is bundled for the browser — and a
 * `node:crypto` import made webpack refuse the whole module with "Reading from node:crypto is not
 * handled by plugins", which arrives as a 500 on the page and nothing at all in tsc. The same shape
 * as the Prisma leak that killed every bit of client JavaScript on a page once before: a value
 * imported from a module that reaches a server-only dependency drags the dependency with it.
 * The Web Crypto API is in both runtimes, so this module has NO imports and cannot do it again.
 *
 * NO MODULO BIAS, and it is asserted rather than reasoned about: 256 divided by a 32-letter
 * alphabet is exactly 8, so every letter is equally likely. Change the alphabet to 30 letters and
 * `% 30` would quietly favour the first 16 — so the constructor-time guard below refuses an
 * alphabet that does not divide 256 instead of leaving a subtle bias to be noticed never.
 */
if (256 % ALPHABET.length !== 0) {
  throw new Error(`affiliate-join: the code alphabet has ${ALPHABET.length} letters, which does not divide 256 — `
    + 'a byte-modulo draw would favour the earlier letters. Pick a length that divides 256, or draw by rejection.');
}

export function mintCandidate(): string {
  const bytes = new Uint8Array(CODE_LENGTH);
  globalThis.crypto.getRandomValues(bytes);
  let s = '';
  for (let i = 0; i < CODE_LENGTH; i++) s += ALPHABET[bytes[i] % ALPHABET.length];
  return s;
}

export const codeShapeOk = (code: string): boolean =>
  code.length === CODE_LENGTH && [...code].every((c) => ALPHABET.includes(c));

/**
 * A code nobody holds — checked CASE-INSENSITIVELY even though the minted alphabet is upper-case
 * only.
 *
 * The reason is not the mint, it is the rest of the table: rep codes were made by hand and are
 * mixed case (measured on production, 2026-10-30), so an upper-case candidate can still collide
 * with 'AbCdEfGh' under the fold that matching applies. Without this, two codes could differ only
 * by case and lib/attribution would answer `ambiguous` for both — nobody paid, and the person who
 * printed a card is the one who finds out.
 *
 * The unique index on lower(ref_code) is the guarantee; this is the courtesy that stops the
 * guarantee being hit in the normal case. Both, because a retry loop alone is a race and an index
 * alone turns a routine collision into a 500.
 */
export async function mintRefCode(db: Db, attempts = 8): Promise<string> {
  for (let i = 0; i < attempts; i++) {
    const candidate = mintCandidate();
    const clash = await db.rep.findFirst({
      where: { ref_code: { equals: candidate, mode: 'insensitive' } },
      select: { id: true },
    });
    if (!clash) return candidate;
  }
  // NAMED, not silent. At 32^8 this cannot happen by chance, so if it ever does the cause is the
  // generator or the query, and a caller swallowing it would hand somebody a duplicate code.
  throw new Error(`mintRefCode: ${attempts} candidates all collided — the generator or the lookup is wrong, not the odds`);
}

export type JoinInput = { name?: unknown; email?: unknown; phone?: unknown; social?: unknown; findMethod?: unknown };
export type JoinFields = { name: string; email: string; phone: string; social: string | null; findMethod: string | null };

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Validate the form, and NAME the field that was wrong. */
export function validateJoin(b: JoinInput): { ok: true; fields: JoinFields } | { ok: false; field: string; message: string } {
  const str = (v: unknown) => String(v ?? '').trim();
  const name = str(b.name);
  const email = str(b.email).toLowerCase();
  const phone = str(b.phone);
  const social = str(b.social);
  const findMethod = str(b.findMethod);

  if (!name) return { ok: false, field: 'name', message: 'Please give us your name.' };
  if (name.length > JOIN_LIMITS.name) return { ok: false, field: 'name', message: `That name is too long (limit ${JOIN_LIMITS.name}).` };
  if (!email) return { ok: false, field: 'email', message: 'Please give us an email address.' };
  if (email.length > JOIN_LIMITS.email) return { ok: false, field: 'email', message: `That email is too long (limit ${JOIN_LIMITS.email}).` };
  if (!EMAIL_RE.test(email)) return { ok: false, field: 'email', message: 'That email address doesn’t look right.' };
  // THE NUMBER IS NOT PARSED HERE. toE164Digits is the spine's normaliser and lives behind
  // sendPhoneVerification, which returns `bad_number` when it cannot resolve one — so a second
  // opinion here could only disagree with the one that matters. This checks it was TYPED.
  if (!phone) return { ok: false, field: 'phone', message: 'Please give us a mobile number — we text a code to check it.' };
  if (phone.length > JOIN_LIMITS.phone) return { ok: false, field: 'phone', message: `That number is too long (limit ${JOIN_LIMITS.phone}).` };
  if (social.length > JOIN_LIMITS.social) return { ok: false, field: 'social', message: `That handle is too long (limit ${JOIN_LIMITS.social}).` };

  // EMPTY IS NULL, NOT ''. An optional field nobody filled in has no value; storing '' makes
  // "not given" and "given as nothing" the same row, and every later reader has to know which.
  return { ok: true, fields: { name, email, phone, social: social || null, findMethod: findMethod || null } };
}

export type ExistingDecision =
  | { action: 'create' }
  | { action: 'carry_on'; repId: string; refCode: string }
  | { action: 'done'; repId: string; refCode: string }
  | { action: 'refuse'; message: string };

/**
 * What to do about an email that is already in the table — the three cases the unique index hides.
 *
 * `phoneVerified` is passed in rather than read here, because the verified number lives on
 * TwoFactorSecret keyed by subject and this module does not otherwise touch it. Pure, so every
 * branch is provable without a row.
 */
export function decideExisting(
  existing: { id: string; party_type: string; ref_code: string; suspended_at: Date | null } | null,
  phoneVerified: boolean,
): ExistingDecision {
  if (!existing) return { action: 'create' };
  if (existing.party_type !== 'affiliate') {
    return {
      action: 'refuse',
      // SAID, NOT HINTED. A reseller agreement is a different arrangement with different terms, and
      // quietly adding an affiliate code to that person's row would put them in two programmes
      // without either being explained to them.
      message: 'That email address is already registered as a GreaseDesk reseller. The two programmes are different arrangements — give us a ring and we’ll sort out which you want.',
    };
  }
  if (existing.suspended_at) {
    return { action: 'refuse', message: 'That account is suspended. Give us a ring and we’ll go through it with you.' };
  }
  // ALREADY FINISHED vs HALF-FINISHED, told apart by the mobile having been proved. A person who
  // lost the tab, or whose text never arrived, gets the SAME row carried on rather than a refusal
  // about an account they do not remember making.
  return phoneVerified
    ? { action: 'done', repId: existing.id, refCode: existing.ref_code }
    : { action: 'carry_on', repId: existing.id, refCode: existing.ref_code };
}

/** The link an affiliate hands out. The apex, because that is where a garage signs up. */
export function referralLink(refCode: string, apexOrigin: string): string {
  return `${apexOrigin.replace(/\/+$/, '')}/register?ref=${encodeURIComponent(refCode)}`;
}
