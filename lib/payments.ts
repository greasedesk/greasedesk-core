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
 *   NULL  no payment row exists at all.
 *   0     rows exist but nothing has cleared yet (a bank transfer inside its window).
 *   n     Σ succeeded payments − Σ refunds.
 * The LEDGER keeps NULL and 0 apart and always will — they are different facts about the rows.
 * What the PRODUCT does with NULL changed on 2026-08-15: it used to mean "possibly paid in cash
 * before this table existed, we cannot know", and the backfill removed that case, so a balance now
 * reads NULL as nothing received. That reading lives in lib/invoice::amountReceivedPennies, with
 * the reasoning and the invariant that holds it up. Do not fold it back in here.
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
 * NOTE: `amountReceivedPennies` / `balanceOwedPennies` live in lib/invoice, NOT here. They are read
 * by the CUSTOMER page, and this module imports node:crypto — which webpack refuses to bundle for
 * the browser. The rule belongs with the other money helpers; this file owns the writes.
 */

/**
 * ── WHY THERE ARE TWO ENTRY POINTS ──────────────────────────────────────────────────────────────
 * A CAUGHT P2002 STILL POISONS ITS TRANSACTION. Postgres aborts the whole block on any failed
 * statement, so once the unique index rejects a duplicate, every subsequent command in that
 * transaction dies with 25P02 — including the reconcileInvoice on the line below. Code that reads
 * as idempotent is not. (Found 2026-08-16: a customer double-tapping Pay got "the payment couldn't
 * be started" on a perfectly good intent.)
 *
 * Whether that can happen at all depends entirely on whether a CALLER-SUPPLIED key is in play:
 *
 *   recordManualPayment  — no sourceRef parameter EXISTS. The key is always `manual:<uuid>`, so a
 *                          collision is impossible and the call is safe anywhere, including deep
 *                          inside a transaction with more work after it (pages/api/jobcard-status).
 *   recordPayment        — takes a sourceRef, so it CAN collide. The caller must let P2002 propagate
 *                          and catch it OUTSIDE the transaction (see lib/card-payment-fulfil).
 *
 * The jobcard-status calls were safe only because nobody had passed a sourceRef — correct by
 * accident, which is a description of a future defect. Splitting the function makes the unsafe call
 * unwritable there rather than merely discouraged: there is no argument to pass.
 */

/**
 * Write a payment and reconcile the invoice. Returns the row, or null if `sourceRef` already existed.
 *
 * ── THE NULL RETURN IS A TRAP INSIDE A TRANSACTION ──────────────────────────────────────────────
 * It swallows P2002 so a redelivered webhook is a no-op — but the transaction is already aborted by
 * then, so anything the caller does afterwards fails, AND reconcileInvoice never ran. Safe only when
 * this is the LAST statement in its transaction and the caller treats a null as "roll back and move
 * on". Prefer catching P2002 outside the transaction entirely.
 *
 * ── `reconstructed` IS DERIVED FROM THE KEY, NEVER PASSED ───────────────────────────────────────
 * A reconstructed row is one the backfill inferred from an invoice marked paid before this table
 * existed; its key is `backfill:<invoice_id>`. Taking the flag as a separate argument would let the
 * two disagree — a row keyed `backfill:` claiming to be observed, or the reverse — and the standing
 * invariant gate asserts they agree in BOTH directions. Deriving it here makes that invariant true
 * by construction instead of by everyone remembering to pass the right pair.
 */
export const RECONSTRUCTED_PREFIX = 'backfill:';

/**
 * A payment taken at the counter: cash, card machine, bank transfer. No external key exists for it,
 * so none can be supplied, so it CANNOT collide — which is what makes it safe to call inside a
 * transaction that continues afterwards.
 */
export async function recordManualPayment(tx: Tx, args: Omit<RecordPaymentArgs, 'sourceRef'>) {
  return recordPayment(tx, args);
}

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
  // No rows at all → leave the column alone. The ledger declines to state a figure it has no rows
  // for; deciding what that ABSENCE means for a balance is the reader's job, not the writer's.
  //
  // ── THIS SILENCE IS CORRECT AND IT WILL CATCH YOU OUT ────────────────────────────────────────
  // Declining to write is right, but it means calling this function does NOT guarantee the column
  // now reflects reality — only that it reflects reality IF there were rows to read. A caller that
  // has just DELETED the last rows and calls this to "put things back" gets the opposite: the
  // column keeps whatever the previous reconcile wrote.
  //
  // That is not hypothetical. A gate teardown on 2026-08-16 removed a fixture payment and its
  // refunds, reconciled, and left a live ZZ invoice at −500 — a negative balance it had never had,
  // because the last write before the deletions had been a refund netting below zero. Restoring a
  // cache means CAPTURING the prior value and writing it back, never recomputing from rows that no
  // longer exist. payment-invariant-gate is what noticed.
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
 * Settle ONE payment, by its own key. Deliberately not settleProcessing, which flips every
 * `processing` row on an invoice: a card payment must settle ITSELF and nothing else. An invoice
 * can legitimately carry a second in-flight intent (the balance changed, so a new one was minted),
 * and settling the wrong one would credit money that never arrived.
 *
 * CLAIM-FIRST, the same idempotency lib/confirm-paid uses: the updateMany is conditioned on the row
 * still being `processing`, so a redelivered webhook claims nothing and reports `settled: false`
 * while still returning the invoice id. The caller can then tell "already done" from "not ours".
 */
export async function settlePaymentByRef(
  tx: Tx,
  sourceRef: string,
  at: Date = new Date(),
): Promise<{ found: boolean; settled: boolean; invoiceId: string | null; amountPennies: number | null }> {
  const row = await (tx as any).payment.findUnique({
    where: { source_ref: sourceRef },
    select: { id: true, invoice_id: true, amount_pennies: true, status: true },
  });
  if (!row) return { found: false, settled: false, invoiceId: null, amountPennies: null };

  const claimed = await (tx as any).payment.updateMany({
    where: { id: row.id, status: 'processing' },
    data: { status: 'succeeded', collected_at: at },
  });
  // Reconcile regardless: a redelivery that claims nothing must still leave the cache correct, and
  // recomputing from the rows is cheap and idempotent.
  await reconcileInvoice(tx, row.invoice_id);
  return { found: true, settled: claimed.count === 1, invoiceId: row.invoice_id, amountPennies: row.amount_pennies };
}

/**
 * The attempt did not become money. `failed` or `canceled` — both are terminal and neither counts,
 * but they are different facts: a declined card is not an abandoned checkout. Claim-first for the
 * same reason as above.
 */
export async function closePaymentByRef(
  tx: Tx,
  sourceRef: string,
  status: 'failed' | 'canceled',
): Promise<{ found: boolean; closed: boolean; invoiceId: string | null }> {
  const row = await (tx as any).payment.findUnique({ where: { source_ref: sourceRef }, select: { id: true, invoice_id: true } });
  if (!row) return { found: false, closed: false, invoiceId: null };
  const claimed = await (tx as any).payment.updateMany({ where: { id: row.id, status: 'processing' }, data: { status } });
  await reconcileInvoice(tx, row.invoice_id);
  return { found: true, closed: claimed.count === 1, invoiceId: row.invoice_id };
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
