/**
 * File: lib/rep-invoice.ts
 * THE REP'S INVOICE TO US — every rule, in one place, so no surface re-derives one.
 *
 * ── WHOSE DOCUMENT THIS IS ──────────────────────────────────────────────────────────────────────
 * The rep's. We are the CUSTOMER. That single fact decides nearly everything below and is the one
 * thing to keep hold of when this file next changes:
 *
 *   • The NUMBER is theirs, from their own sales ledger, unique to them and not to us. Two reps may
 *     both issue 001; the same rep may not issue it twice.
 *   • It is FROZEN ON SUBMISSION — the PDF bytes are stored and hashed and never re-rendered. A
 *     garage invoice rebuilds from frozen lines because we own it. Rebuilding this one would be
 *     forging another business's books, which is why refuseIfSubmitted guards every path rather
 *     than each caller remembering.
 *   • A wrong one is REJECTED and resubmitted under a NEW number, or credit-noted. Never edited.
 *
 * ── LANGUAGE ────────────────────────────────────────────────────────────────────────────────────
 * Sales Commission. Never wage, never salary, never "pay" as a noun for the rep.
 */
// ── THIS MODULE REACHES NO DATABASE, DELIBERATELY ─────────────────────────────────────────────
// Every rule here is pure, and lib/company-info + lib/rep-pay-run are pure too (rep-pay-run's only
// @prisma/client import is a TYPE import, which the compiler erases). So a page may import from
// here without dragging PrismaClient into its bundle — the mistake that cost the customer pay page
// on 2026-09-08 and the rep sign-in page on 2026-09-09, both times through one small helper.
// The WRITE path lives in lib/rep-invoice-submit, which does reach the database and which no client
// component may import. client-bundle-gate holds both halves.
import { COMPANY, officeOneLine } from '@/lib/company-info';
import { isArrears } from '@/lib/rep-pay-run';

export type Refusal = { code: string; message: string };

/**
 * ── WHAT A PROFILE MUST HAVE BEFORE A FIRST INVOICE ─────────────────────────────────────────────
 * These four, and the UTR IS NOT AMONG THEM. A UTR is not an invoice requirement — HMRC does not
 * ask for one on a sales invoice — so blocking a submission on one would be inventing a rule that
 * does not exist and stranding a rep who has not found the letter. It is collected because it is
 * useful to hold, and it gates nothing, ever. rep-invoice-gate asserts that both ways.
 *
 * VAT counts as ANSWERED, not as REGISTERED: `false` is a complete answer. Rep.vat_registered is
 * nullable precisely so "not asked" and "no" are different states — a two-state boolean would make
 * an unanswered profile indistinguishable from a genuine no, which is the difference between
 * refusing to invoice and issuing a wrong one.
 */
export const REQUIRED_PROFILE_FIELDS = ['trading_name', 'address_line1', 'address_postcode', 'contact_email', 'vat_registered'] as const;
export type ProfileField = (typeof REQUIRED_PROFILE_FIELDS)[number];

export type ProfileSubject = {
  trading_name: string | null;
  address_line1: string | null;
  address_postcode: string | null;
  contact_email: string | null;
  vat_registered: boolean | null;
};

/** Missing fields, in declaration order. Empty = complete. `vat_registered: false` is COMPLETE. */
export function missingProfileFields(rep: ProfileSubject): ProfileField[] {
  return REQUIRED_PROFILE_FIELDS.filter((f) => {
    const v = rep[f];
    if (f === 'vat_registered') return v === null || v === undefined;
    return v === null || v === undefined || String(v).trim() === '';
  });
}

export const profileComplete = (rep: ProfileSubject): boolean => missingProfileFields(rep).length === 0;

/**
 * ── DOES VAT GO ON THIS DOCUMENT? ───────────────────────────────────────────────────────────────
 * Registered AND the invoice is dated on or after registration took effect.
 *
 * The second half is the whole reason vat_effective_from exists. A rep who crossed the threshold in
 * September is registered TODAY and was not in July, and their July invoice must render without
 * VAT — otherwise registering would retrospectively add VAT to periods that were never VATable,
 * on documents already filed.
 *
 * Returns a BOOLEAN and takes the date explicitly: nothing here reads the clock, so the gate can
 * ask the same question on both sides of the boundary without moving anything.
 */
export function vatAppliesTo(
  rep: { vat_registered: boolean | null; vat_effective_from: Date | null },
  invoiceDate: Date,
): boolean {
  if (rep.vat_registered !== true || !rep.vat_effective_from) return false;
  return invoiceDate.getTime() >= rep.vat_effective_from.getTime();
}

/** UK standard rate, in basis points. One place; a future 17.5% is a forward row, not a migration. */
export const VAT_RATE_BP = 2000;

/**
 * ── VAT IS A REFUSAL, NOT AN OMISSION ───────────────────────────────────────────────────────────
 * Asked BEFORE anything is built, so an unregistered rep's generator stops rather than quietly
 * producing a document with the VAT block left off. The difference matters: a renderer that "leaves
 * it off" is one edit from putting it back, and a generator that refuses cannot be edited into
 * charging VAT nobody is registered to charge.
 *
 * RepInvoice_vat_chk is the same rule in the database, so a caller that skipped this cannot write
 * the row either. Two layers on purpose — this one explains, that one cannot be bypassed.
 */
export function refuseVat(
  rep: { vat_registered: boolean | null; vat_effective_from: Date | null },
  invoiceDate: Date,
): Refusal | null {
  if (vatAppliesTo(rep, invoiceDate)) return null;
  if (rep.vat_registered !== true) {
    return { code: 'not_vat_registered', message: 'This rep is not VAT registered, so no VAT may be added to their invoice.' };
  }
  return {
    code: 'before_vat_registration',
    message: 'This invoice is dated before VAT registration took effect, so it carries no VAT.',
  };
}

/**
 * ── THE ONE PREDICATE THAT SAYS WHETHER THIS DOCUMENT MAY STILL CHANGE ──────────────────────────
 * The canEditInvoice shape: one predicate, many callers, and nobody re-derives "submitted" for
 * themselves. Every status here is submitted — submission IS creation, there is no draft — so the
 * honest answer is always no, and that is the point rather than a placeholder.
 *
 * A garage invoice can be unlocked, corrected and re-issued because it is OURS. This one cannot be
 * touched at all. Renderers ask this before doing anything; rep-invoice-gate asserts that nothing
 * calls the renderer for a submitted invoice.
 */
export function refuseIfSubmitted(inv: { id: string; status: string }): Refusal | null {
  return {
    code: 'submitted',
    message: `Invoice ${inv.id} was submitted by the rep and is their accounting record. `
      + 'It is never edited or re-rendered — reject it and ask for a new number, or raise a credit note.',
  };
}

/**
 * THE NEXT NUMBER TO OFFER. Their last plus one when it ends in digits, so 001 → 002 and
 * GD-2026-14 → GD-2026-15, KEEPING THE PADDING. A PREFILL AND NOTHING MORE: it is their series and
 * they may type whatever their books say. Null last → null, so a first-time rep gets an empty box
 * rather than our guess at how they number things.
 */
export function nextInvoiceNumber(last: string | null): string | null {
  if (!last) return null;
  const m = /^(.*?)(\d+)$/.exec(last.trim());
  if (!m) return null;
  const next = String(Number(m[2]) + 1);
  return m[1] + next.padStart(m[2].length, '0');
}

// ── THE RENDERABLE DOCUMENT ───────────────────────────────────────────────────────────────────
export type RepInvoiceLineDoc = {
  period: string;
  isArrears: boolean;
  garage: string;
  description: string;
  amountPennies: number;
};

export type RepInvoiceDoc = {
  number: string;
  invoiceDate: Date;
  taxPoint: Date | null;
  currency: string;
  /** The ISSUER — the rep. */
  from: { tradingName: string; address: string; contact: string | null; vatNumber: string | null };
  /** The CUSTOMER — us. */
  to: { name: string; address: string; companyNumber: string };
  lines: RepInvoiceLineDoc[];
  subtotalPennies: number;
  vatApplied: boolean;
  vatRateBp: number | null;
  vatPennies: number | null;
  totalPennies: number;
  /** NULL = we hold no bank details for this rep. Rendered as missing, never as a blank field. */
  payTo: { accountName: string; sortCode: string; accountNumber: string } | null;
};

const addressOf = (r: { address_line1: string | null; address_line2: string | null; address_locality: string | null; address_region: string | null; address_postcode: string | null }) =>
  [r.address_line1, r.address_line2, r.address_locality, r.address_region, r.address_postcode].filter(Boolean).join(', ');

/**
 * BUILD THE DOCUMENT. Pure — no database, no clock — so the gate can render both sides of a VAT
 * boundary from one rep row and compare them.
 *
 * VAT is computed on the SUBTOTAL, once, not per line: every line is the same supply at the same
 * rate, so a per-line rounding would introduce differences of a penny between the document and the
 * total the rep's own books expect.
 */
export function buildRepInvoiceDoc(args: {
  rep: ProfileSubject & {
    vat_effective_from: Date | null; vat_number: string | null;
    address_line1: string | null; address_line2: string | null; address_locality: string | null;
    address_region: string | null; address_postcode: string | null;
    bank_account_name: string | null; bank_sort_code: string | null; bank_account_number: string | null;
  };
  number: string;
  invoiceDate: Date;
  currency: string;
  lines: RepInvoiceLineDoc[];
}): RepInvoiceDoc {
  const subtotalPennies = args.lines.reduce((a, l) => a + l.amountPennies, 0);
  const vatApplied = vatAppliesTo(args.rep, args.invoiceDate);
  const vatPennies = vatApplied ? Math.round((subtotalPennies * VAT_RATE_BP) / 10000) : null;
  return {
    number: args.number,
    invoiceDate: args.invoiceDate,
    // NO VAT, NO TAX POINT. There is no tax point on a document that is not a VAT invoice, and a
    // date printed under that heading anyway would be a fact we invented.
    taxPoint: vatApplied ? args.invoiceDate : null,
    currency: args.currency,
    from: {
      tradingName: args.rep.trading_name ?? '',
      address: addressOf(args.rep),
      contact: args.rep.contact_email,
      vatNumber: vatApplied ? args.rep.vat_number : null,
    },
    to: { name: COMPANY.legalName, address: officeOneLine(), companyNumber: COMPANY.companyNumber },
    lines: args.lines,
    subtotalPennies,
    vatApplied,
    vatRateBp: vatApplied ? VAT_RATE_BP : null,
    vatPennies,
    totalPennies: subtotalPennies + (vatPennies ?? 0),
    // ALL THREE OR NONE — Rep_bank_chk holds that in the database, and this reads it the same way
    // rather than assembling a partial block that looks filled in.
    payTo: args.rep.bank_account_name && args.rep.bank_sort_code && args.rep.bank_account_number
      ? { accountName: args.rep.bank_account_name, sortCode: args.rep.bank_sort_code, accountNumber: args.rep.bank_account_number }
      : null,
  };
}

/** The line a released commission entry becomes on the rep's invoice. */
export const commissionLineDescription = (period: string, garage: string) => `Sales Commission — ${garage} — ${period}`;

/**
 * ── WHAT A REP MAY SEE OF A COMMISSION LINE ─────────────────────────────────────────────────────
 * SHAPED HERE, SERVER-SIDE, AND THE OMISSION IS THE MECHANISM. CommissionEntry carries
 * held_reason, release_override_reason and shown_as_visited — the area manager's private assessment
 * OF THIS REP. A rep must never see any of the three, and the way to be sure is that they are not
 * in the object the page receives, not that a component remembers to skip them.
 *
 * Same rule, and the same reasoning, as unit_cost never leaving lib/invoice-doc and the rep's login
 * email never entering lib/tenant-rep's select: "the safest way to keep them out of a page is to
 * keep them out of the object the page receives."
 */
export type RepVisibleLine = { period: string; isArrears: boolean; garage: string; amountPennies: number };

export function repVisibleLine(
  entry: { period: string; amount_pennies: number },
  garage: string,
  runPeriod: string,
): RepVisibleLine {
  return {
    period: entry.period,
    isArrears: isArrears(entry.period, runPeriod),
    garage,
    amountPennies: entry.amount_pennies,
  };
}
