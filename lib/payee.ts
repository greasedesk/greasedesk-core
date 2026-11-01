/**
 * File: lib/payee.ts
 * WHO WE PAY, AND WHAT MAKES A PROPOSED PAYEE REFUSABLE. The rules, as pure functions.
 *
 * A LEAF ON PURPOSE: no node:crypto, no lib/db at module scope, so a form component can import the
 * closed sets and the masks without dragging either into the browser bundle. The encryption lives
 * next door in lib/payee-crypto, which is server-only; the one db-reading rule here takes its client
 * as an argument.
 *
 * ── THE SHAPE OF THE FEATURE, IN ONE PARAGRAPH ──────────────────────────────────────────────────
 * An affiliate PROPOSES a payee; the owner APPLIES it. Nothing here pays anybody and nothing here
 * writes Rep.bank_*. The reason is in lib/rep-magic-link's header: the link is the credential and
 * the mailbox is the account, so a self-serve bank form would let whoever holds the inbox redirect
 * the money. Collecting a proposal is safe; acting on it is the owner's.
 */

/** Matches RepPayeeRequest_payee_kind_chk. The database holds the same set; payee-gate proves it. */
export const PAYEE_KINDS = ['self', 'nominee'] as const;
export type PayeeKind = (typeof PAYEE_KINDS)[number];

/** Matches RepPayeeRequest_status_chk, in lifecycle order. */
export const PAYEE_REQUEST_STATUSES = ['pending', 'applied', 'rejected', 'superseded'] as const;
export type PayeeRequestStatus = (typeof PAYEE_REQUEST_STATUSES)[number];

/**
 * GB BANK DETAILS: six digits and eight. Named constants because the numbers appear in a refusal
 * message, a maxLength and a gate clause, and three copies of "8" is three things to change.
 *
 * GB-ONLY IS A REAL LIMIT, NOT AN OVERSIGHT. Admission is GB-only (one allow-list in the single
 * country writer), so a sort code and an account number is the whole of what we can be given today.
 * An IBAN is a different shape and a different validation, and widening this to guess at one would
 * be a parser widened for prose.
 */
export const SORT_CODE_DIGITS = 6;
export const ACCOUNT_NUMBER_DIGITS = 8;

const digits = (raw: string | null | undefined): string => String(raw ?? '').replace(/\D+/g, '');

/** '20-00-00' / '20 00 00' / '200000' all normalise to '200000'. Stored normalised; shown grouped. */
export const normaliseSortCode = (raw: string | null | undefined): string => digits(raw);
export const normaliseAccountNumber = (raw: string | null | undefined): string => digits(raw);

/** '200000' → '20-00-00'. Display only; never the stored form. */
export function formatSortCode(sortCode: string): string {
  const d = digits(sortCode);
  return d.length === SORT_CODE_DIGITS ? `${d.slice(0, 2)}-${d.slice(2, 4)}-${d.slice(4, 6)}` : d;
}

/**
 * ── THE FIELD, AS SOMEBODY TYPES IT (owner, 2026-11-01) ─────────────────────────────────────────
 * `11-03-00` appears as the sixth digit lands, and a paste of '11 03 00', '110300' or '11-03-00'
 * all settle to the same thing. What is SENT is still the six digits — normaliseSortCode — so the
 * grouping never reaches the database and the route's refusal is unchanged.
 *
 * formatSortCode above groups a COMPLETE code for display and deliberately hands back a partial one
 * untouched; a field needs the opposite, because a person types one digit at a time. Two functions
 * rather than a flag, because a reader of either should not have to work out which half it is doing.
 *
 * ── DELETING A SEPARATOR DELETES THE DIGIT IN FRONT OF IT ───────────────────────────────────────
 * Without that, the field cannot be edited from the right: backspace over the '-' in '11-03' leaves
 * the six digits unchanged, the grouping puts the dash straight back, and the key appears to do
 * nothing at all. `previous` is what the field held before this keystroke, which is the only way to
 * tell "they removed a separator" from "they removed a digit" — the digits alone cannot say.
 */
export function sortCodeAsTyped(raw: string | null | undefined, previous: string | null | undefined = ''): string {
  const now = String(raw ?? '');
  const was = String(previous ?? '');
  let d = digits(now).slice(0, SORT_CODE_DIGITS);

  if (now.length < was.length && digits(now) === digits(was)) {
    // WHERE the separator was removed, so the digit that goes with it is the one in FRONT of it and
    // not simply the last one typed. Deleting the dash in '11-03-00' is meant to take the 3.
    let at = 0;
    while (at < now.length && now[at] === was[at]) at += 1;
    const before = digits(was.slice(0, at)).slice(0, -1);
    d = `${before}${digits(was.slice(at))}`.slice(0, SORT_CODE_DIGITS);
  }

  // A DASH AFTER EVERY PAIR THAT HAS A DIGIT AFTER IT — so '11' shows as '11' and not '11-', and a
  // trailing dash is never something the person has to delete to carry on typing.
  return d.replace(/(\d{2})(?=\d)/g, '$1-');
}

/**
 * ── TWO MASKS, FROM ONE STORED VALUE, ANSWERING TWO DIFFERENT QUESTIONS ─────────────────────────
 * The affiliate's question is "did my details arrive" — two digits settle that and reveal least.
 * The owner's question is "is this the account I am about to pay" — four digits is what makes a
 * remittance checkable against a bank screen.
 *
 * One knob answering both would be wrong for one of them, so there are two, each named for its
 * reader. Both derive from the same stored `account_last4`, so they cannot disagree.
 */
export const maskedForAffiliate = (last4: string): string => `ending ••${digits(last4).slice(-2)}`;
export const maskedForOwner = (last4: string): string => `••••${digits(last4).slice(-4)}`;

export type PayeeProposal = {
  payeeKind: string;
  accountName: string;
  sortCode: string;
  accountNumber: string;
  nomineeEmail?: string | null;
};

/**
 * EVERY REFUSAL FOR A PROPOSED PAYEE, as a sentence or null. One function, so the API and the form
 * cannot disagree about what is acceptable, and so a gate can ask the question without a browser.
 *
 * THE MESSAGES ARE FOR THE PERSON TYPING. "Enter the eight digits of your account number" is
 * actionable; "invalid account_number" is a developer talking to themselves.
 */
/**
 * ── THE NAME ON ITS OWN, because two callers now ask about it (owner, 2026-11-01) ───────────────
 * The affiliate proposing a payee, and the owner CORRECTING a name that was typed wrong. The second
 * one may touch the name and nothing else, so it cannot go through refusePayee — which would demand
 * a sort code and an account number it is deliberately not being given.
 *
 * ONE RULE, TWO CALLERS, rather than a second length check written out beside the first: the pair
 * that drifts is always the one that was copied because the shapes did not quite fit.
 *
 * NO FORMAT RULE BEYOND LENGTH, and that is deliberate. A bank account name is whatever the bank
 * holds — initials, an ampersand, a trading name, an apostrophe, a second language — and a
 * character class here would refuse a real person's real account. The control on this field is a
 * person reading it beside the digits, which is why the screen puts them next to each other.
 */
export function refuseAccountName(raw: string | null | undefined): string | null {
  const name = String(raw ?? '').trim();
  if (name.length < 2) return 'Enter the name on the account, exactly as the bank holds it.';
  if (name.length > 140) return 'That account name is too long for a bank transfer.';
  return null;
}

export function refusePayee(p: PayeeProposal): string | null {
  if (!PAYEE_KINDS.includes(p.payeeKind as PayeeKind)) {
    return 'Choose whether we pay you or someone you nominate.';
  }
  const nameRefusal = refuseAccountName(p.accountName);
  if (nameRefusal) return nameRefusal;

  const sort = normaliseSortCode(p.sortCode);
  if (sort.length !== SORT_CODE_DIGITS) return `Enter the ${SORT_CODE_DIGITS} digits of the sort code.`;

  const acct = normaliseAccountNumber(p.accountNumber);
  if (acct.length !== ACCOUNT_NUMBER_DIGITS) return `Enter the ${ACCOUNT_NUMBER_DIGITS} digits of the account number.`;
  // ALL ZEROS IS NOT AN ACCOUNT. A plausible-looking placeholder that reaches a pay run is worse
  // than a blank one, because a blank one is obviously unfinished.
  if (/^0+$/.test(acct)) return 'That is not an account number.';

  if (p.payeeKind === 'nominee') {
    const email = String(p.nomineeEmail ?? '').trim();
    // THE ADDRESS IS REQUIRED FOR A NOMINEE AND ONLY FOR A NOMINEE. It is the one half of "never the
    // referred garage or its staff" that can be mechanised — see refuseNomineeIsReferredStaff.
    if (!email || !/^[^@\s]+@[^@\s.]+\.[^@\s]+$/.test(email)) {
      return 'Give an email address for the person you are nominating, so we can check who they are.';
    }
  }
  return null;
}

/** What actually gets stored, after the refusals have passed. Normalised once, here. */
export function normalisedPayee(p: PayeeProposal): {
  payeeKind: PayeeKind; accountName: string; sortCode: string; accountNumber: string; nomineeEmail: string | null;
} {
  return {
    payeeKind: p.payeeKind as PayeeKind,
    accountName: String(p.accountName ?? '').trim(),
    sortCode: normaliseSortCode(p.sortCode),
    accountNumber: normaliseAccountNumber(p.accountNumber),
    nomineeEmail: p.payeeKind === 'nominee' ? String(p.nomineeEmail ?? '').trim().toLowerCase() : null,
  };
}

type Db = { user: { findFirst: (args: any) => Promise<any> }; tenantAffiliateTerms: { findMany: (args: any) => Promise<any[]> } };

/**
 * ── NEVER THE REFERRED GARAGE OR ITS STAFF ──────────────────────────────────────────────────────
 * The owner's rule, and this enforces the half of it that CAN be enforced: the nominated address
 * must not belong to a User of any garage this affiliate introduced. A reward is for introducing a
 * garage, not for a garage paying itself through someone who works there.
 *
 * WHAT IT DELIBERATELY DOES NOT DO IS COMPARE NAMES. Two people legitimately share a name, one
 * person spells theirs three ways, and a garage owner's wife may be a perfectly proper nominee. A
 * name comparison would refuse honest requests and pass dishonest ones, which is the worst of both:
 * it reads like a control and is not one.
 *
 * SO THE REAL CONTROL IS THE OWNER'S APPROVAL SCREEN, which prints the nominee beside the owners of
 * the garages this affiliate referred. This function is the mechanical floor under that, not a
 * substitute for it — the same division as the advisory parts-plausibility rules.
 */
export async function refuseNomineeIsReferredStaff(
  db: Db,
  args: { affiliateId: string; nomineeEmail: string | null },
): Promise<string | null> {
  const email = (args.nomineeEmail ?? '').trim().toLowerCase();
  if (!email) return null; // paying themselves, or nothing to check — not a refusal

  const terms = await db.tenantAffiliateTerms.findMany({
    where: { affiliate_id: args.affiliateId },
    select: { group_id: true },
  });
  // NOTHING TO CHECK IS NOT CHECKED, and here that is genuinely fine: an affiliate who has referred
  // no garage cannot nominate one's staff. Said out loud so the empty case is not mistaken for a
  // clean result of a search that ran.
  if (terms.length === 0) return null;

  const hit = await db.user.findFirst({
    where: { email, group_id: { in: terms.map((t: any) => t.group_id) } },
    select: { id: true },
  });
  if (!hit) return null;
  // IT DOES NOT NAME THE GARAGE. Telling an affiliate which of their referrals that address belongs
  // to would answer a question about somebody else's staff list.
  return 'We cannot pay that address: it belongs to someone at a garage you introduced. '
    + 'A reward is for introducing a garage, so the payee has to be you or someone outside it.';
}
