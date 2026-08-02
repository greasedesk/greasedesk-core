/**
 * File: lib/invoice-void.ts
 * THE void rules, in one place: what a void IS, what may be voided, and what counts as a reason.
 * Pure — no prisma, no session — so the endpoint, any future UI and the gate all read the same
 * decision rather than three copies of it.
 *
 * ── WHY A VOID RETAINS THE DOCUMENT ─────────────────────────────────────────────────────────────
 * HMRC VATREC5010 accepts a break in a sequential series "as long as you retain the cancelled or
 * spoiled invoice in your accounting records, or you can provide an explanation for the break in
 * sequence". A void therefore keeps its number, its frozen InvoiceLine snapshot and its company/
 * customer/vehicle snapshots, and carries the explanation on the row. Deleting the invoice would
 * satisfy neither limb — it leaves an unexplained gap, which is exactly the state TMBS is already
 * in for twelve July numbers.
 *
 * ── A VOID IS NOT A CREDIT NOTE ─────────────────────────────────────────────────────────────────
 * A credit note is a countervailing document ISSUED TO THE CUSTOMER for a genuine mistake,
 * overcharge or agreed reduction, within 14 days, that "gives value to the customer"
 * (VATREC13040). It needs its own number, series and particulars. Void is the other case: a
 * document retired because it should not have existed. Do not conflate them, and do not let this
 * file grow into a credit-note implementation.
 *
 * ── WHY FROZEN LINES ARE A PRECONDITION ─────────────────────────────────────────────────────────
 * `invoice-unlock` deletes the frozen lines and leaves `issued` with none — an empty husk that
 * contributes nothing and reads as "mid-correction". Voiding THAT would retire a document with no
 * contents, which retains nothing. A void must be a complete document, so lines must be present.
 */

/** The four real reasons an invoice gets retired. A picker collects better data than free text
 *  alone and is faster to answer honestly than a blank box. */
export const VOID_CATEGORIES = ['issued_in_error', 'duplicate', 'wrong_customer', 'test_or_demo'] as const;
export type VoidCategory = (typeof VOID_CATEGORIES)[number];

export const MIN_REASON_LENGTH = 12;

/**
 * THE REASON IS MANDATORY, and this is the deliberate exception to "a mandatory field becomes a
 * field full of x". Elsewhere the reason is incidental — someone leaving is a fact whether or not
 * anyone says why. Here the reason IS the deliverable: VATREC5010 makes the gap acceptable
 * *because* it can be explained, so a void with no explanation does not do the job it exists for.
 *
 * The guard below is not clever validation, just enough that "x" and "xxxxxxxxxxxx" fail and a
 * real sentence passes. Void is admin-only and rare, so nobody develops an autopilot answer.
 */
export function validateVoidReason(reason: unknown): { ok: true; value: string } | { ok: false; error: string } {
  const s = String(reason ?? '').trim();
  if (!s) return { ok: false, error: 'Say why this invoice is being voided — it is the record that explains the gap in the numbering.' };
  if (s.length < MIN_REASON_LENGTH) return { ok: false, error: `Give a bit more detail — at least ${MIN_REASON_LENGTH} characters.` };
  // One character repeated (with or without spaces) is a placeholder, not an explanation.
  if (new Set(s.replace(/\s+/g, '')).size <= 1) return { ok: false, error: 'That is not an explanation. Write what actually happened.' };
  return { ok: true, value: s.slice(0, 500) };
}

export function isVoidCategory(v: unknown): v is VoidCategory {
  return typeof v === 'string' && (VOID_CATEGORIES as readonly string[]).includes(v);
}

/**
 * May this invoice be voided? Statuses are deliberately narrow: only a live, frozen, chargeable-or-
 * warranty document that nobody has paid. `paid`/`paid_pending` must be unmarked first — money
 * having changed hands is a different conversation from a document issued in error, and silently
 * discarding the payment grain is what `unlock` does and what this must not.
 */
export function canVoid(inv: { status: string; lineCount: number }): { ok: true } | { ok: false; code: string; message: string } {
  if (inv.status === 'void') return { ok: false, code: 'already_void', message: 'This invoice is already voided.' };
  if (inv.status === 'paid' || inv.status === 'paid_pending') {
    return { ok: false, code: 'is_paid', message: 'This invoice is marked paid. Unmark or unlock the payment first — voiding must not silently discard a payment record.' };
  }
  if (inv.status !== 'issued') {
    return { ok: false, code: 'bad_status', message: `An invoice in state “${inv.status}” cannot be voided.` };
  }
  if (inv.lineCount === 0) {
    return { ok: false, code: 'no_lines', message: 'This invoice is unlocked and has no lines, so there is no document to retain. Re-issue it first, then void it.' };
  }
  return { ok: true };
}

/**
 * ── OFF-LEDGER: THE ONE PLACE THAT SAYS "A VOID IS NOT MONEY" ───────────────────────────────────
 * Same shape as OFF_DIARY_STATUSES in lib/jobcard-status (a cancelled job keeps its slot data but
 * stops occupying a lift): a voided invoice keeps its number, lines and snapshots but stops being
 * money. Six figures hang off fetchLedgerInvoices alone, so this is written ONCE and spread in,
 * never restated per query. `notIn` rather than `not` so a second off-ledger status is one edit.
 *
 * ⚠ ONLY SPREAD THIS INTO A WHERE CLAUSE THAT DOES NOT ALREADY NAME `status`.
 * `{ status: 'issued', ...notVoided }` does NOT mean "issued and not void" — the later key WINS,
 * so it silently becomes "anything except void", and the debtors view would start counting PAID
 * invoices. Queries with a positive allow-list (debtors' `status: 'issued'`, the VAT return's
 * `status: { in: [...] }`) are ALREADY safe by construction, because 'void' is not in their list.
 * Leave them alone — see the note at each site.
 */
export const OFF_LEDGER_STATUSES = ['void'] as const;

/** Spread into any invoice query that selects BY DATE without naming a status. */
export const notVoided = { status: { notIn: [...OFF_LEDGER_STATUSES] as string[] } };

/**
 * One recorded amendment to a void reason: {at, by, from, to} — deliberately the same shape as
 * EmploymentEvent.correction_json, written by redateEvent/voidEvent. Repeat amendments stack.
 */
export type VoidCorrection = { at: string; by: string | null; from: string; to: string };

export function readVoidCorrections(v: unknown): VoidCorrection[] {
  return Array.isArray(v) ? (v as VoidCorrection[]).filter((c) => c && typeof c.to === 'string') : [];
}

/** The ORIGINAL wording, whatever it has since become: the first amendment's `from`, else current. */
export function originalVoidReason(current: string | null, corrections: unknown): string | null {
  const log = readVoidCorrections(corrections);
  return log.length ? log[0].from : current;
}

/** THE resurrection guard, used by every path that could bring a void back to life. One predicate,
 *  so a new path cannot be added that forgets the rule — see the guarded list in the void endpoint. */
export function refuseIfVoid(inv: { status: string } | null | undefined): { code: string; message: string } | null {
  if (inv?.status !== 'void') return null;
  return { code: 'voided', message: 'This invoice has been voided and cannot be changed, re-issued or re-sent. Raise a new invoice instead.' };
}
