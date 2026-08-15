/**
 * File: lib/invoice-pay-link.ts
 * THE one place an `invoice_pay` link is decided on and minted. Today the email is its only caller;
 * the PDF, the QR code and the SMS are the next slice and must call THIS, not mint their own — a
 * customer holding three different links to one invoice is three different tokens to revoke and
 * three chances for one of them to point somewhere stale.
 *
 * ── A LINK IS A DEMAND, SO A RECEIPT MUST NOT CARRY ONE ─────────────────────────────────────────
 * sendInvoiceEmail has four callers and two of them are RECEIPTS (lib/confirm-paid and
 * pages/api/invoice-confirm-paid, both firing after money has arrived). "Pay now" on a receipt is
 * how a garage gets a phone call from a customer who thinks they have been billed twice. The
 * decision is a predicate here rather than a condition at each call site, because there are four
 * call sites and there will be more.
 */
import { prisma } from '@/lib/db';
import { createMagicLink, invoicePayExpiry, type CreatedMagicLink } from '@/lib/magic-link';
import type { InvoiceDoc } from '@/lib/invoice-doc';

/**
 * Should this document carry a way to pay?
 *
 * `issued` only. Each exclusion is a document that would be lying if it asked for money:
 *   paid / paid_pending / settled — a receipt, or money already in flight
 *   void                          — retired; there is nothing to pay
 *   under correction              — unlocked, lines dropped; the amount is not final and the
 *                                   customer is about to be sent a different one
 *   warranty                      — £0.00 due by construction
 *   zero total                     — nothing owed, whatever the series says
 *
 * NOTE the deliberate omission: an invoice whose `amountPaidPennies` is NULL still gets a link.
 * Unknown is not "nothing owed", the document is a genuine demand, and the customer view says
 * plainly that the balance has to come from the garage. When the payment slice lands it is the PAY
 * button that must refuse an unknown balance — not the link, which is also how a customer reads
 * the invoice at all.
 */
export function offersPayLink(doc: Pick<InvoiceDoc, 'status' | 'underCorrection' | 'series' | 'vatRegistered' | 'totals'>): boolean {
  if (doc.status !== 'issued') return false;
  if (doc.underCorrection) return false;
  if (doc.series === 'warranty') return false;
  return (doc.vatRegistered ? doc.totals.grossPennies : doc.totals.netPennies) > 0;
}

/**
 * Mint the link, or return null when the document should not carry one. The lifetime comes from the
 * invoice's own due date (lib/magic-link::invoicePayExpiry) — read here rather than carried on the
 * InvoiceDoc, because `due_date` is deliberately NOT printed on the document (ruling) and putting
 * it on the shared doc shape is an invitation to print it.
 */
export async function mintInvoicePayLink(args: {
  doc: InvoiceDoc;
  groupId: string;
  recipient: string;
  createdByUserId?: string | null;
}): Promise<CreatedMagicLink | null> {
  if (!offersPayLink(args.doc)) return null;

  const inv = (await prisma.invoice.findUnique({
    where: { id: args.doc.invoiceId },
    select: { due_date: true, issued_at: true },
  })) as { due_date: Date | null; issued_at: Date } | null;
  if (!inv) return null;

  return createMagicLink({
    groupId: args.groupId,
    jobCardId: args.doc.jobCardId,
    invoiceId: args.doc.invoiceId,
    purpose: 'invoice_pay',
    recipient: args.recipient,
    createdByUserId: args.createdByUserId ?? null,
    expiresAt: invoicePayExpiry({ dueDate: inv.due_date, issuedAt: inv.issued_at }),
  });
}
