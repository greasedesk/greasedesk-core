/**
 * File: lib/commission-billing.ts
 * THE Stripe-payload → commission-engine adapter. This is the ONLY place a Stripe payment event turns
 * into a commission ledger entry, and it does NOT compute commission itself — it maps the event onto a
 * Payment/Refund and hands it to lib/commission (accruePayment / clawbackRefund). One engine, many
 * readers; this is a reader that happens to be fed by Stripe.
 *
 * ── TWO PROGRAMMES, ONE ADAPTER (2026-10-29) ───────────────────────────────────────────────────
 * It maps onto the RESELLER engine (lib/commission, rates and tapers) and onto the AFFILIATE
 * programme (lib/affiliate, a flat sum frozen at signup). They are different rules over one ledger
 * table, and they are both here for the reason this file exists: so there is one place a Stripe
 * payment event becomes a ledger entry. They answer a PARTIAL refund differently on purpose: a
 * reseller's share of the money is clawed back in proportion, an affiliate's flat reward stands. The affiliate half was written in full and never called
 * from anywhere but a gate — the functions below are what reached it.
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
import { rewardPaidInvoice, reverseAffiliateReward, wholeChargeRefunded } from '@/lib/affiliate';
import { listChargeRefunds, refundCounts, type RefundLite } from '@/lib/stripe-refunds';
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


// ── THE AFFILIATE HALF ──────────────────────────────────────────────────────────────────────────
// lib/affiliate holds the rules — £30 a paid month for the first four, a £120 cap, a single £120 on
// a paid annual offer invoice, nothing for an unactivated code, nothing on a garage you work for.
// These two functions are the ONLY production callers of them.

/** A paid invoice may earn an affiliate reward. Never throws into the webhook: a refusal is data. */
export async function rewardFromInvoicePaid(db: Db, invoice: Stripe.Invoice): Promise<BillingResult> {
  const inv = invoice as any;
  const invoiceId: string | null = inv.id ?? null;
  const paidPennies: number = inv.amount_paid ?? 0;
  const status: string = String(inv.status ?? '');
  // THE DATE THE MONEY ARRIVED, from Stripe's own transition, falling back to the invoice's
  // creation only when the transition is absent. NOT the clock: rewardPaidInvoice dates the
  // activation rule and the ledger period from it, and a re-delivered webhook must answer both
  // the same way the first delivery did.
  const paidAt = unixToDate(inv.status_transitions?.paid_at) ?? unixToDate(inv.created);
  if (!invoiceId || !paidAt) return { status: 'skipped', reason: 'invoice carries no id or no paid date' };

  const groupId = await groupIdForCustomer(db, idOf(inv.customer));
  if (!groupId) return { status: 'skipped', reason: 'unknown Stripe customer' };

  try {
    const r = await rewardPaidInvoice(db as any, { groupId, invoiceId, paidPennies, status, paidAt });
    return r.paid
      ? { status: 'accrued', groupId, written: 1, noop: 0 }
      // THE TENANT IN THE REASON, because BillingResult's `skipped` carries no groupId and the
      // webhook logs this line verbatim. "not referred by an affiliate" about nobody in particular
      // is a log entry that cannot be followed up.
      : { status: 'skipped', reason: `${groupId}: ${r.why}` };
  } catch (e: any) {
    // RECORDED, NOT RETHROWN. A throw here would 500 the webhook, Stripe would retry, and the
    // FIRST PAYMENT write that runs before it has already committed — so the retry would be about
    // a reward while everything else about the payment was already correct. The refusal is money
    // an affiliate is owed and did not get, so it is logged loudly rather than swallowed.
    console.error('[commission-billing] affiliate reward refused for', groupId, invoiceId, e?.message);
    return { status: 'skipped', reason: `${groupId}: affiliate reward threw: ${String(e?.message ?? e).slice(0, 160)}` };
  }
}

export type AffiliateReversalDecision =
  | { reverse: false; why: string }
  | { reverse: true; refundId: string; refundedAt: Date; refundedPennies: number };

/**
 * ── IS THE AFFILIATE REWARD REVERSED BY THIS? ───────────────────────────────────────────────────
 * PURE, and exported for that reason: the reversal path cannot be driven end to end in a gate,
 * because listChargeRefunds asks Stripe and refuses to answer without a client. The decision this
 * function makes IS the rule, so it is the thing a clause must be able to hold — synthetic refund
 * lists in, a decision out, no database and no network.
 *
 * ONE DECISION ABOUT THE CHARGE, not one per refund. Under the owner's amendment of 2026-10-30
 * only a full refund reverses, and a full refund may be the sum of several partials — so the
 * question is about the TOTAL, and the reversal is keyed on the refund that completed it. That
 * identity is stable across re-deliveries (Stripe will not permit a further refund once the charge
 * is fully refunded, so the completing refund never changes), which is what keeps source_ref
 * idempotent.
 *
 * THE REP CLAWBACK ABOVE IS DELIBERATELY NOT THIS. A reseller's commission is a SHARE of the money,
 * so a partial refund claws back a proportion of it, per refund; an affiliate's reward is a flat sum
 * for a referral, so it either stands or goes. Two parties, two rules, one ledger — they are not in
 * conflict and neither should be "tidied" into the other.
 */
export function affiliateReversalFromRefunds(args: {
  chargePennies: number;
  chargeCreated: Date | null;
  refunds: RefundLite[];
}): AffiliateReversalDecision {
  // A failed or cancelled refund moved no money. refundCounts is the shared answer to that.
  const counted = args.refunds.filter(refundCounts);
  const refundedPennies = counted.reduce((n, r) => n + (r.amount ?? 0), 0);
  if (!wholeChargeRefunded({ chargePennies: args.chargePennies, refundedPennies })) {
    return { reverse: false, why: `only ${refundedPennies}p of ${args.chargePennies}p refunded — a partial refund leaves the affiliate reward standing` };
  }
  // LATEST BY created, tie-broken on the id so two refunds in the same second always pick the same
  // one. `at(-1)` of an ascending sort, because the last one is the one that completed it.
  const completing = [...counted]
    .sort((a, b) => (a.created.getTime() - b.created.getTime()) || (a.id < b.id ? -1 : 1))
    .at(-1);
  if (!completing) return { reverse: false, why: 'no refund on this charge counted, so there is nothing to date a reversal from' };

  // DATED FROM THE REFUND, falling back only to the charge. NOT the clock: a reversal filed in the
  // wrong month reads as new work in a pay run, so an undated refund is REFUSED rather than stamped
  // with today. listChargeRefunds turns an absent `created` into new Date(0), which is why this
  // tests the instant rather than the presence of the object.
  const fromRefund = completing.created && completing.created.getTime() > 0 ? completing.created : null;
  const refundedAt = fromRefund ?? (args.chargeCreated && args.chargeCreated.getTime() > 0 ? args.chargeCreated : null);
  if (!refundedAt) return { reverse: false, why: `refund ${completing.id} carries no date, and a reversal must be filed in the month the money went back` };

  return { reverse: true, refundId: completing.id, refundedAt, refundedPennies };
}

/**
 * Money given back reverses the reward it earned — ALL of it going back, that is. The REFUND half of
 * the policy in lib/affiliate; the chargeback half waits on the Dispute work, and nothing here
 * pretends otherwise.
 *
 * The refunds are ASKED OF STRIPE rather than read off the event, for the reason the rep clawback
 * above records: `refunds` has not been included on a Charge by default since API 2022-11-15, and
 * reading it off the event is how the card-refund path came to write nothing at all. Under the
 * amended rule that reader matters more, not less: the full/partial question is about the CUMULATIVE
 * total, and the event body for the first of three partials cannot answer it.
 */
export async function reverseAffiliateFromChargeRefunded(db: Db, charge: Stripe.Charge): Promise<BillingResult> {
  const c = charge as any;
  const invoiceId: string | null = idOf(c.invoice);
  if (!invoiceId) return { status: 'skipped', reason: 'charge not tied to an invoice' };

  const groupId = await groupIdForCustomer(db, idOf(c.customer));
  if (!groupId) return { status: 'skipped', reason: 'unknown Stripe customer' };

  // WHAT WE ACTUALLY TOOK, which is amount_captured when it says anything: a refund can only ever be
  // up to the captured amount, so comparing a total refund against an AUTHORISED amount would read
  // a fully-refunded charge as partial and leave the reward standing on money that is all back.
  const chargePennies: number =
    (typeof c.amount_captured === 'number' && c.amount_captured > 0 ? c.amount_captured : c.amount) ?? 0;
  if (chargePennies <= 0) return { status: 'skipped', reason: `${groupId}: charge carries no captured amount` };

  const decision = affiliateReversalFromRefunds({
    chargePennies, chargeCreated: unixToDate(c.created), refunds: await listChargeRefunds(c.id, {}),
  });
  // THE TENANT IN THE REASON — the webhook logs this verbatim, and "partially refunded" about
  // nobody in particular cannot be followed up.
  if (!decision.reverse) return { status: 'skipped', reason: `${groupId}: ${decision.why}` };

  try {
    const r = await reverseAffiliateReward(db as any, {
      groupId, invoiceId, refundId: decision.refundId, refundedAt: decision.refundedAt,
      chargePennies, refundedPennies: decision.refundedPennies,
    });
    return { status: 'clawed', groupId, written: r.reversed ? 1 : 0, noop: r.reversed ? 0 : 1 };
  } catch (e: any) {
    console.error('[commission-billing] affiliate reversal refused for', groupId, decision.refundId, e?.message);
    return { status: 'skipped', reason: `${groupId}: affiliate reversal threw: ${String(e?.message ?? e).slice(0, 160)}` };
  }
}
