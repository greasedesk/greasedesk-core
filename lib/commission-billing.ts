/**
 * File: lib/commission-billing.ts
 * THE Stripe-payload → commission-engine adapter. This is the ONLY place a Stripe payment event turns
 * into a commission ledger entry, and it does NOT compute commission itself — it maps the event onto a
 * Payment/Refund and hands it to lib/commission (accruePayment / clawbackRefund). One engine, many
 * readers; this is a reader that happens to be fed by Stripe.
 *
 * Called only from the signature-verified, event-id-deduped webhook (pages/api/stripe/webhook). The
 * money path deliberately reads everything from the EVENT PAYLOAD + the DB — no live Stripe API calls —
 * so it is fast, resilient to Stripe outages, and testable with synthetic signed events.
 *
 * JOIN: Stripe customer → tenant is GroupBilling.stripe_customer_id → group_id (the customer is never
 * passed to the engine; we resolve to the group first). TRIAL: the engine trial-gates on
 * Group.trial_ends_at (kept in sync from the subscription's trial_end by lib/stripe-billing-cache), so a
 * during-trial invoice accrues nothing here — no extra logic. IDEMPOTENCY: source_ref is the Stripe
 * INVOICE id (accrual) / REFUND id (clawback) — the payment-object identity, stronger than the event id,
 * so a re-delivered or duplicate-typed event can never double-write (CommissionEntry unique on source_ref).
 */
import type Stripe from 'stripe';
import type { PrismaClient } from '@prisma/client';
import { accruePayment, clawbackRefund } from '@/lib/commission';
import { resolveAttribution } from '@/lib/attribution';

type Db = PrismaClient;
const unixToDate = (s: number | null | undefined): Date | null => (s ? new Date(s * 1000) : null);
const idOf = (v: string | { id: string } | null | undefined): string | null =>
  (typeof v === 'string' ? v : v?.id) ?? null;

async function groupIdForCustomer(db: Db, customerId: string | null): Promise<string | null> {
  if (!customerId) return null;
  const b = await db.groupBilling.findUnique({ where: { stripe_customer_id: customerId }, select: { group_id: true } });
  return b?.group_id ?? null;
}

/** Active attributions AT an instant (mirrors the engine's own rule), used only to decide "is there a rep
 *  to pay?" — an unattributed tenant is a safe no-op, not an error. */
async function hasActiveAttributionAt(db: Db, groupId: string, at: Date): Promise<boolean> {
  const n = await db.tenantAttribution.count({
    where: { group_id: groupId, effective_from: { lte: at }, OR: [{ ended_at: null }, { ended_at: { gt: at } }] },
  });
  return n > 0;
}

export type BillingResult =
  | { status: 'accrued'; groupId: string; written: number; noop: number }
  | { status: 'clawed'; groupId: string; written: number; noop: number }
  | { status: 'skipped'; reason: string };

/**
 * invoice.paid → accrual. Resolves the tenant, runs resolveAttribution (so a ref that only now matches a
 * rep still attributes), then accrues through the engine (which trial-gates on Group.trial_ends_at).
 */
export async function accrueFromInvoicePaid(db: Db, invoice: Stripe.Invoice): Promise<BillingResult> {
  const inv = invoice as any;
  const invoiceId: string | null = inv.id ?? null;
  const amountPaid: number = inv.amount_paid ?? 0;
  const currency: string = String(inv.currency ?? '').toUpperCase();
  const collectedAt = unixToDate(inv.status_transitions?.paid_at) ?? unixToDate(inv.created);
  if (!invoiceId || amountPaid <= 0 || !currency || !collectedAt) return { status: 'skipped', reason: 'not a positive collected invoice' };

  const groupId = await groupIdForCustomer(db, idOf(inv.customer));
  if (!groupId) return { status: 'skipped', reason: 'unknown Stripe customer' };

  // Resolve a captured ?ref= into an attribution if it now matches a rep (idempotent; no-op if not).
  await resolveAttribution(db as any, groupId).catch(() => {});

  // No rep to pay at this instant → safe no-op (most tenants have no attribution). The engine would
  // throw "no active attribution"; we never crash the webhook on that expected case.
  if (!(await hasActiveAttributionAt(db, groupId, collectedAt))) return { status: 'skipped', reason: 'no active attribution' };

  const payment = { ref: invoiceId, collected_at: collectedAt, amount_pennies: amountPaid, currency };
  try {
    const r = await accruePayment(db as any, groupId, payment); // trial gate inside → during trial = {written:0}
    return { status: 'accrued', groupId, written: r.written, noop: r.noop };
  } catch (e: any) {
    // A genuine config error (e.g. shares ≠ 10000). Log loudly, acknowledge the webhook (don't wedge
    // Stripe into infinite retry over a data-config issue); the missing entry is visible + fixable.
    console.error('[commission-billing] accrual refused for', groupId, e?.message);
    return { status: 'skipped', reason: `engine refused: ${e?.message}` };
  }
}

/**
 * charge.refunded → clawback. Reconstructs the ORIGINAL payment from the charge (so the engine re-derives
 * the same frozen tier/rate) and claws back each refund on the charge, keyed on the refund id — so a
 * re-delivered charge.refunded (or multiple partials) is exactly-once per refund.
 */
export async function clawbackFromChargeRefunded(db: Db, charge: Stripe.Charge): Promise<BillingResult> {
  const c = charge as any;
  const invoiceId: string | null = idOf(c.invoice);
  const origAmount: number = c.amount ?? 0;
  const currency: string = String(c.currency ?? '').toUpperCase();
  const origCollectedAt = unixToDate(c.created);
  if (!invoiceId || origAmount <= 0 || !currency || !origCollectedAt) return { status: 'skipped', reason: 'charge not tied to a collectable invoice' };

  const groupId = await groupIdForCustomer(db, idOf(c.customer));
  if (!groupId) return { status: 'skipped', reason: 'unknown Stripe customer' };

  const orig = { ref: invoiceId, collected_at: origCollectedAt, amount_pennies: origAmount, currency };
  const refunds: any[] = c.refunds?.data ?? [];
  let written = 0, noop = 0;
  for (const rf of refunds) {
    const refundId: string | null = rf.id ?? null;
    const refundAmount: number = rf.amount ?? 0;
    const refundedAt = unixToDate(rf.created) ?? new Date(origCollectedAt);
    if (!refundId || refundAmount <= 0) continue;
    try {
      const r = await clawbackRefund(db as any, groupId, { ref: refundId, payment_ref: invoiceId, amount_pennies: refundAmount, refunded_at: refundedAt }, orig);
      written += r.written; noop += r.noop;
    } catch (e: any) {
      console.error('[commission-billing] clawback refused for', groupId, refundId, e?.message);
    }
  }
  return { status: 'clawed', groupId, written, noop };
}
