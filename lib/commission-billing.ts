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
import { accruePayment, clawbackRefund, isCommissionError } from '@/lib/commission';
import { listChargeRefunds, refundCounts } from '@/lib/stripe-refunds';
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
    // A LATER SUCCESS CLOSES AN EARLIER REFUSAL. The rate got added, the shares got fixed, and the
    // webhook was replayed — the board should stop asking about it rather than keep a scar.
    await resolveRefusals(db, groupId, invoiceId);
    return { status: 'accrued', groupId, written: r.written, noop: r.noop };
  } catch (e: any) {
    // A genuine config error (e.g. shares ≠ 10000, or no rate for the tier this tenant just moved
    // into). Acknowledge the webhook — wedging Stripe into infinite retry over OUR config error
    // helps nobody — but the refusal is money a rep is owed and did not get, so it is RECORDED and
    // not merely logged. The log line stays: it is what someone greps at two in the morning.
    console.error('[commission-billing] accrual refused for', groupId, e?.code ?? '—', e?.message);
    await recordRefusal(db, groupId, invoiceId, e);
    return { status: 'skipped', reason: `engine refused: ${e?.message}` };
  }
}

/**
 * Keep the refusal. Idempotent on (group, payment, code): a re-delivered webhook records once, and
 * a DIFFERENT failure on the same payment is a separate row because it is a separate thing to fix.
 *
 * NEVER throws. This runs inside a webhook handler that has already decided to acknowledge, and a
 * failure to write the record must not turn a handled refusal into a 500 and an infinite retry.
 */
async function recordRefusal(db: Db, groupId: string, sourceRef: string, e: any): Promise<void> {
  try {
    // The CODE is the API (lib/commission COMMISSION_ERROR.*); the prose rides along for humans.
    // An untyped throw is not one of ours — record it as such rather than pretending we know.
    const code = isCommissionError(e) ? String(e.code) : 'COMMISSION_UNKNOWN';
    await (db as any).commissionRefusal.upsert({
      where: { group_id_source_ref_code: { group_id: groupId, source_ref: sourceRef, code } },
      update: {}, // first sighting wins; a replay is not a new event
      create: {
        group_id: groupId, source_ref: sourceRef, code,
        message: String(e?.message ?? 'unknown').slice(0, 1000),
        detail: (e?.detail ?? null) as any,
      },
    });
  } catch (writeErr: any) {
    console.error('[commission-billing] could NOT record the refusal for', groupId, sourceRef, '—', writeErr?.message);
  }
}

/** Close any open refusal for this payment. Same never-throw rule as the writer. */
async function resolveRefusals(db: Db, groupId: string, sourceRef: string): Promise<void> {
  try {
    await (db as any).commissionRefusal.updateMany({
      where: { group_id: groupId, source_ref: sourceRef, resolved_at: null },
      data: { resolved_at: new Date() },
    });
  } catch { /* a stale open row is a nuisance; a thrown webhook is an outage */ }
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

  // ── ASKED OF STRIPE, NOT READ OFF THE EVENT ────────────────────────────────────────────────
  // This was `c.refunds?.data ?? []`, the identical assumption that made the card-refund path write
  // nothing: `refunds` has not been included on a Charge by default since API 2022-11-15. Here the
  // consequence was a rep keeping commission on subscription money we had given back — and unlike
  // its twin this endpoint has been receiving charge.refunded all along, so it has simply never had
  // a refund to be wrong about. NO accountId: a subscription charge is ours, not a garage's, and
  // scoping this to a connected account would look in the wrong place and truthfully find nothing.
  const refunds = (await listChargeRefunds(c.id, {})).filter(refundCounts);

  let written = 0, noop = 0;
  for (const rf of refunds) {
    const refundId: string | null = rf.id ?? null;
    const refundAmount: number = rf.amount ?? 0;
    const refundedAt = rf.created ?? new Date(origCollectedAt);
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
