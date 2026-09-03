/**
 * File: lib/invoice-addressee.ts
 * CORRECTING WHO AN INVOICE IS ADDRESSED TO — the shape of the record, and the rules of the door.
 *
 * ── THE POLICY THIS IMPLEMENTS ──────────────────────────────────────────────────────────────────
 * The four addressee columns are `correctable` in lib/invoice-snapshots: not `rebuild`, because
 * re-reading them from the customer would restate a past transaction in the present's terms; not
 * `frozen`, because an invoice addressed to the wrong party is a mistake and nothing else can carry
 * the fix. A garage asked to bill an employer had no path at all — unlock, type the company in,
 * re-issue, and the document came back exactly as it was.
 *
 * ── A GUARDED EXCEPTION, NOT AN UNLOCK ──────────────────────────────────────────────────────────
 * Deliberately the same shape lib/invoice-void's amend path claims for itself, because that is the
 * only thing that makes a door in a freeze worth having:
 *   · ADMIN only, and only while the invoice is UNDER CORRECTION (unlocked, lines dropped);
 *   · four columns and nothing else — never the status, number, lines, dates or money;
 *   · a MANDATORY reason, an append-only log, and an audit row, every time;
 *   · refused outright once a CREDIT NOTE exists (see below).
 *
 * ── WHY A CREDIT NOTE CLOSES IT ─────────────────────────────────────────────────────────────────
 * mintCreditNote copies the addressee off the invoice at mint, under a stated rule: the pair must
 * read as a pair. A credit note cannot be changed — it is an immutable VAT document with its own
 * gapless number — so correcting the invoice afterwards leaves two documents in a customer's hands
 * correcting each other and addressed to different parties. That is a worse state than the one
 * being fixed, and the refusal is conservative on purpose: it looks BACKWARDS only, so a credit
 * note raised after a correction is fine by construction.
 *
 * ── NOT PART OF RE-ISSUE ────────────────────────────────────────────────────────────────────────
 * Re-issue is about the charges and the car. It refuses on estimate divergence, so a garage fixing
 * an addressee would be blocked by an unrelated money problem; its confirmation dialog talks about
 * what was paid and what is now outstanding, which would bury this; and its amendment log fires
 * only when the TOTAL moves, so a correction folded into it would leave no record at all.
 */
import type { Prisma } from '@prisma/client';

/** The four fields that ARE the bill-to block, as one value. */
export type AddresseeSnapshot = {
  customerName: string;
  customerAddress: string | null;
  accountName: string | null;
  accountAddress: string | null;
};

/**
 * One recorded correction — the same {at, by, …} shape as void_reason_corrections and
 * EmploymentEvent.correction_json, plus the reason this one is required to carry. BOTH sides are
 * stored: the original is the first entry's `from` and survives every later correction, so a
 * document can always say what it used to say.
 */
export type AddresseeCorrection = {
  at: string;
  by: string | null;
  reason: string;
  from: AddresseeSnapshot;
  to: AddresseeSnapshot;
};

export function readAddresseeCorrections(v: unknown): AddresseeCorrection[] {
  return Array.isArray(v)
    ? (v as AddresseeCorrection[]).filter((c) => c && typeof c === 'object' && !!c.to && typeof c.to.customerName === 'string')
    : [];
}

/**
 * THE PRINTED FORM, and the reason this lives here rather than in each renderer. A correction log
 * shows what a document used to say, and "what it used to say" has to be built by the SAME rule
 * that builds what it says now — otherwise the two disagree about a case like an account with no
 * address, and the history looks like a different kind of document from the page above it.
 */
export function printedAddressee(a: AddresseeSnapshot): string {
  const lines = a.accountName
    ? [a.accountName, a.accountAddress, a.customerName ? `for ${a.customerName}` : null]
    : [a.customerName, a.customerAddress];
  return lines.filter((l) => typeof l === 'string' && l.trim()).join('\n');
}

/** The four columns as they stand on a row, in the one order everything reads them. */
export function addresseeOf(inv: {
  customer_name_snapshot: string;
  customer_address_snapshot: string | null;
  account_name_snapshot: string | null;
  account_address_snapshot: string | null;
}): AddresseeSnapshot {
  return {
    customerName: inv.customer_name_snapshot,
    customerAddress: inv.customer_address_snapshot,
    accountName: inv.account_name_snapshot,
    accountAddress: inv.account_address_snapshot,
  };
}

/** Blank is blank, everywhere: '' and '   ' are absence, and only customerName may not be absent. */
const clean = (v: string | null | undefined): string | null =>
  typeof v === 'string' && v.trim() ? v.trim() : null;

export function normaliseAddressee(input: {
  customerName?: string | null; customerAddress?: string | null;
  accountName?: string | null; accountAddress?: string | null;
}): AddresseeSnapshot | null {
  const customerName = clean(input.customerName);
  // WITHOUT A CUSTOMER NAME THERE IS NO DOCUMENT. The column is NOT NULL, and a correction that
  // emptied it would leave an invoice addressed to nobody — refused rather than coerced to ''.
  if (!customerName) return null;
  return {
    customerName,
    customerAddress: clean(input.customerAddress),
    // An account ADDRESS with no account NAME bills nobody, exactly as at the mint
    // (lib/invoice::resolveBilledParty). Dropped here so the two paths cannot disagree.
    accountName: clean(input.accountName),
    accountAddress: clean(input.accountName) ? clean(input.accountAddress) : null,
  };
}

export const sameAddressee = (a: AddresseeSnapshot, b: AddresseeSnapshot): boolean =>
  a.customerName === b.customerName && a.customerAddress === b.customerAddress
  && a.accountName === b.accountName && a.accountAddress === b.accountAddress;

/** A reason is the record somebody reads later. Mandatory, for the same reason a void's is. */
export const MAX_REASON = 500;
export function validateAddresseeReason(v: unknown): { ok: true; reason: string } | { ok: false; message: string } {
  const r = typeof v === 'string' ? v.trim() : '';
  if (!r) return { ok: false, message: 'Say why this invoice is being re-addressed — the reason is the record of what happened.' };
  return { ok: true, reason: r.slice(0, MAX_REASON) };
}

/**
 * ── THE REFUSALS, AS ONE PREDICATE ──────────────────────────────────────────────────────────────
 * Stated here rather than open-coded in the endpoint so a second caller cannot appear with a
 * softer version of the same rules. Returns null when the correction may proceed.
 */
export function refuseCorrection(inv: {
  status: string;
  hasFrozenLines: boolean;
  creditNoteCount: number;
  creditNoteNumber?: string | null;
}): { code: string; message: string } | null {
  if (inv.status === 'void') {
    return { code: 'voided', message: 'This invoice has been voided. A retired document is not re-addressed — raise a new invoice instead.' };
  }
  // ONCE A CREDIT NOTE EXISTS THE PAIR MUST NOT BE SPLIT. Checked ahead of the unlock state so the
  // message names the real obstacle: telling somebody to unlock an invoice they will then be
  // refused on is a worse answer than telling them why now.
  if (inv.creditNoteCount > 0) {
    return {
      code: 'credit_note_exists',
      message: `This invoice has a credit note${inv.creditNoteNumber ? ` (${inv.creditNoteNumber})` : ''}, and a credit note cannot be changed. Correcting the addressee now would leave the two documents addressed to different parties. Void this invoice and raise it again to the right party instead.`,
    };
  }
  if (!(inv.status === 'issued' && !inv.hasFrozenLines)) {
    return {
      code: 'not_under_correction',
      message: 'Unlock this invoice first. The addressee can only be corrected while the document is under correction — then re-issue to freeze it again.',
    };
  }
  return null;
}

/** Append, never replace: the original is the first entry's `from` and must survive every later one. */
export function appendCorrection(
  existing: unknown,
  entry: AddresseeCorrection,
): Prisma.InputJsonValue {
  return [...readAddresseeCorrections(existing), entry] as unknown as Prisma.InputJsonValue;
}
