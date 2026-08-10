/**
 * File: lib/account-terms.ts
 * ACCOUNT CUSTOMERS: who is on terms, when their invoice falls due, and what "overdue" means.
 *
 * ── THE DEFAULT IS THE GARAGE FORECOURT, NOT THE ACCOUNTS DEPARTMENT ────────────────────────────
 * A garage does not release a car until the bill is paid, so retail work is paid on collection and
 * there is no retail receivable at all. That is why `account_terms_days` is NULLABLE and why NULL
 * means retail: the absence of terms is the normal case, not missing data. An unpaid retail invoice
 * is not a debtor, it is a car still sitting in the yard.
 *
 * ── ONE COLUMN, SO IT CANNOT CONTRADICT ITSELF ──────────────────────────────────────────────────
 * The flag and the terms are the same fact. A separate `is_trade` boolean could be true with no
 * terms set, or false with terms set, and then something downstream has to pick a winner.
 *
 * ── FROZEN AT ISSUE ─────────────────────────────────────────────────────────────────────────────
 * The due date is computed once, in the mint, from the terms as they stood at that moment — the
 * same freeze-at-issue rule the lines follow. Deriving it live from the customer would mean putting
 * a fleet account on 60 days next year silently re-ages every invoice they have ever had.
 *
 * ── OVERDUE IS DERIVED, NEVER STORED ────────────────────────────────────────────────────────────
 * A stored flag needs a nightly job to flip it, and is wrong between midnight and whenever that job
 * runs. `due_date < now` costs nothing and is right at every instant.
 */

/** The longest terms anyone can set. Beyond this it is a loan, not an invoice. */
export const MAX_TERMS_DAYS = 180;

/** Is this customer on account? The presence of terms IS the answer. */
export const isAccountCustomer = (c: { account_terms_days?: number | null } | null | undefined): boolean =>
  typeof c?.account_terms_days === 'number' && c.account_terms_days > 0;

/**
 * Terms as typed, or null. Rejects nonsense rather than storing it: zero days is not an account
 * (it is collection), and a negative is a due date before the invoice.
 */
export function normaliseTermsDays(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = Math.floor(Number(v));
  if (!Number.isFinite(n) || n <= 0 || n > MAX_TERMS_DAYS) return null;
  return n;
}

/**
 * The due date for an invoice being minted now, or NULL for collection.
 *
 * Whole days from the DOCUMENT date, at the same time of day — not normalised to midnight, because
 * the only comparison made against it is `< now`, and an invoice issued at 16:00 on 30-day terms is
 * not late at 00:01 on the thirtieth day.
 */
export function dueDateFor(
  customer: { account_terms_days?: number | null } | null | undefined,
  issuedAt: Date,
): Date | null {
  const days = normaliseTermsDays(customer?.account_terms_days);
  if (days === null) return null;
  return new Date(issuedAt.getTime() + days * 86_400_000);
}

/**
 * The overdue predicate, as a Prisma `where` fragment.
 *
 * `due_date: { not: null }` is not decoration. Every invoice raised before this column existed has
 * a NULL due date, and SQL would happily read that as "no deadline, therefore not yet due" in one
 * place and "no deadline, therefore due immediately" in another. Stating it makes the back
 * catalogue's exclusion a decision rather than an accident of null semantics.
 */
export const overdueWhere = (now: Date = new Date()) => ({
  status: 'issued' as const,
  due_date: { not: null, lt: now },
});

/** Days past due for display. Null when the invoice has no deadline or has not passed it. */
export function daysOverdue(
  inv: { due_date?: Date | string | null; status?: string },
  now: Date = new Date(),
): number | null {
  if (!inv?.due_date || inv.status !== 'issued') return null;
  const d = new Date(inv.due_date);
  if (Number.isNaN(d.getTime())) return null;
  const ms = now.getTime() - d.getTime();
  return ms <= 0 ? null : Math.floor(ms / 86_400_000);
}
