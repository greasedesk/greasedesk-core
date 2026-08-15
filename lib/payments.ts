/**
 * File: lib/payments.ts
 * THE payment ledger chokepoint. Every receipt of funds becomes a Payment row here, and
 * Invoice.amount_paid_pennies is recomputed from those rows — never written by hand again.
 *
 * ── ONE LEDGER, FOUR DOORS ──────────────────────────────────────────────────────────────────────
 * Money changes state in exactly four places: mark-paid (jobcard-status), the manual confirm
 * (invoice-confirm-paid), the clearance sweep (lib/confirm-paid) and the silent revert
 * (invoice-unmark-paid). All four now go through this file, so "what has this invoice been paid?"
 * has one answer computed one way.
 *
 * ── THE CACHE IS DERIVED, AND ITS NULL MEANS SOMETHING ──────────────────────────────────────────
 *   NULL  no payment row exists at all — unknown. Every invoice paid before this table did.
 *   0     rows exist but nothing has cleared yet (a bank transfer inside its window). We know that
 *         nothing has arrived, which is a different statement from not knowing.
 *   n     Σ succeeded payments − Σ refunds.
 * Collapsing 0 and NULL would erase the distinction the whole honest-null discipline rests on.
 *
 * ── PENDING MONEY IS NOT MONEY ──────────────────────────────────────────────────────────────────
 * A windowed or manual method records a Payment at `processing`, not `succeeded`: the garage has
 * been told a transfer is coming, and the clearance window exists precisely because it might not
 * arrive. Only `succeeded` counts. An instant method (cash, card machine) is `succeeded` at once.
 */
import type { Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';

type Tx = Prisma.TransactionClient;

/** Only these count towards the cache. Kept as one list so no caller invents a second opinion. */
export const COUNTED_STATUSES = ['succeeded'] as const;

export type RecordPaymentArgs = {
  groupId: string;
  invoiceId: string;
  siteId?: string | null;
  amountPennies: number;
  currency?: string;
  /** 'succeeded' for money in hand; 'processing' while a clearance window runs. */
  status: 'succeeded' | 'processing';
  paymentMethodId?: string | null;
  paymentMethodSnapshot?: string | null;
  collectedAt: Date;
  createdBy?: string | null;
  /**
   * Idempotency. Omit for a manual payment and a fresh `manual:<uuid>` is minted — deliberately NOT
   * derived from the invoice id, because an invoice can be marked paid, unmarked and marked again,
   * and a derived key would collide on the second attempt and silently drop it.
   */
  sourceRef?: string;
  provider?: 'manual' | 'stripe';
};

/**
 * THE RULE, as a pure function: what should Invoice.amount_paid_pennies be, given this invoice's
 * ledger? Exported so the standing gate can assert against the REAL rule rather than a copy — a
 * gate that reimplements the arithmetic only ever proves it agrees with itself.
 *
 *   no rows        → null   (unknown: every invoice paid before this table existed)
 *   rows, none succeeded → 0    (we know nothing has cleared — not the same as not knowing)
 *   otherwise      → Σ succeeded − Σ refunded
 */
export function expectedCachePennies(
  payments: Array<{ status: string; amount_pennies: number }>,
  refunds: Array<{ amount_pennies: number }>,
): number | null {
  if (payments.length === 0) return null;
  const received = payments
    .filter((p) => (COUNTED_STATUSES as readonly string[]).includes(p.status))
    .reduce((a, p) => a + p.amount_pennies, 0);
  const returned = refunds.reduce((a, r) => a + r.amount_pennies, 0);
  return received - returned;
}

/**
 * Write a payment and reconcile the invoice. Returns the row, or null if `sourceRef` already existed.
 *
 * ── `reconstructed` IS DERIVED FROM THE KEY, NEVER PASSED ───────────────────────────────────────
 * A reconstructed row is one the backfill inferred from an invoice marked paid before this table
 * existed; its key is `backfill:<invoice_id>`. Taking the flag as a separate argument would let the
 * two disagree — a row keyed `backfill:` claiming to be observed, or the reverse — and the standing
 * invariant gate asserts they agree in BOTH directions. Deriving it here makes that invariant true
 * by construction instead of by everyone remembering to pass the right pair.
 */
export const RECONSTRUCTED_PREFIX = 'backfill:';

export async function recordPayment(tx: Tx, args: RecordPaymentArgs) {
  const source_ref = args.sourceRef ?? `manual:${randomUUID()}`;
  const reconstructed = source_ref.startsWith(RECONSTRUCTED_PREFIX);
  try {
    const row = await (tx as any).payment.create({
      data: {
        group_id: args.groupId,
        invoice_id: args.invoiceId,
        site_id: args.siteId ?? null,
        provider: args.provider ?? 'manual',
        status: args.status,
        amount_pennies: args.amountPennies,
        currency: args.currency ?? 'GBP',
        payment_method_id: args.paymentMethodId ?? null,
        payment_method_snapshot: args.paymentMethodSnapshot ?? null,
        source_ref,
        reconstructed,
        collected_at: args.collectedAt,
        created_by: args.createdBy ?? null,
      },
    });
    await reconcileInvoice(tx, args.invoiceId);
    return row;
  } catch (e: any) {
    // A redelivered webhook is a no-op, not an error — the same rule CommissionEntry uses.
    if (e?.code === 'P2002') return null;
    throw e;
  }
}

/**
 * Recompute Invoice.amount_paid_pennies from the ledger. THE only writer of that column from now on.
 * Called inside the same transaction as whatever moved the money, so the cache cannot lag its rows.
 */
export async function reconcileInvoice(tx: Tx, invoiceId: string): Promise<number | null> {
  const [payments, refunds] = await Promise.all([
    (tx as any).payment.findMany({ where: { invoice_id: invoiceId }, select: { status: true, amount_pennies: true } }),
    (tx as any).refund.findMany({ where: { payment: { invoice_id: invoiceId } }, select: { amount_pennies: true } }),
  ]);
  // No rows at all → leave it UNKNOWN. This is what keeps every historic invoice honest until the
  // backfill runs: absence of a ledger is not evidence that nothing was paid.
  const net = expectedCachePennies(payments, refunds);
  if (net === null) return null;

  await (tx as any).invoice.update({ where: { id: invoiceId }, data: { amount_paid_pennies: net } });
  return net;
}

/**
 * A clearance window closed and the money is real. Flips every `processing` row on the invoice to
 * `succeeded` and reconciles. Idempotent: a second call finds nothing to flip and recomputes the
 * same figure, which matters because the cron and the manual confirm race each other by design.
 */
export async function settleProcessing(tx: Tx, invoiceId: string, at: Date = new Date()): Promise<number> {
  const r = await (tx as any).payment.updateMany({
    where: { invoice_id: invoiceId, status: 'processing' },
    data: { status: 'succeeded', collected_at: at },
  });
  await reconcileInvoice(tx, invoiceId);
  return r.count;
}

/**
 * The payment was recorded in error and the garage silently reverted it. The row is CANCELLED, not
 * deleted: someone did record a payment, the audit trail says so, and a ledger that quietly loses
 * its mistakes is worse at explaining itself than one that keeps them. Cancelled rows never count.
 */
export async function cancelProcessing(tx: Tx, invoiceId: string): Promise<number> {
  const r = await (tx as any).payment.updateMany({
    where: { invoice_id: invoiceId, status: 'processing' },
    data: { status: 'canceled' },
  });
  await reconcileInvoice(tx, invoiceId);
  return r.count;
}
