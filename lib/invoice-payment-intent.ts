/**
 * File: lib/invoice-payment-intent.ts
 * THE one place a customer's card payment against an invoice is set up.
 *
 * ── EVERY FIGURE IS RE-DERIVED HERE, NOTHING COMES FROM THE PAGE ────────────────────────────────
 * The amount is the balance recomputed from the frozen lines and the ledger at this instant, not a
 * number the browser sent. A page can be old, forged, or simply open since Tuesday while the garage
 * took £200 in cash. The client sends a token and nothing else that touches money.
 *
 * ── A ROW IS WRITTEN AT CREATION, SO THE WEBHOOK NEED NOT TRUST METADATA ────────────────────────
 * The obvious design puts the invoice id in PaymentIntent.metadata and reads it back on
 * `payment_intent.succeeded`. Metadata on a DIRECT charge is editable by anyone with access to the
 * garage's own Stripe dashboard — which is the same reason connect-webhook resolves accounts by the
 * id WE stored rather than by the metadata we set. So the binding is established here, server-side:
 * a Payment row at `processing`, keyed `source_ref = pi_…`. The webhook finds it by key. Metadata is
 * still set, for a human reading Stripe's dashboard, and is never read back by us.
 *
 * ── PENDING MONEY IS NOT MONEY ──────────────────────────────────────────────────────────────────
 * `processing` does not count towards the cache (lib/payments::COUNTED_STATUSES), so an invoice with
 * a payment in flight reads £0 received rather than paid. Fulfilment — the flip to `succeeded` — is
 * the webhook's job and only the webhook's. The browser returning from a card form proves nothing:
 * it can be closed, refreshed, or replayed, and 3-D Secure can complete after it has gone.
 *
 * ── LAPSED TENANTS KEEP TAKING PAYMENTS (ruling 2026-08-15) ─────────────────────────────────────
 * There is deliberately NO billingGate call here. The money is the garage's, in the garage's own
 * Stripe account, from their customer. Withholding it over our subscription would be us holding a
 * third party's money hostage. billingGate means "no new work", not "no receiving what you are owed".
 */
import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import { getStripe, stripePublishableKey } from '@/lib/stripe';
import { buildInvoiceDoc, type InvoiceDoc } from '@/lib/invoice-doc';
import { balanceOwedPennies } from '@/lib/invoice';
import { readConnection, providerState } from '@/lib/provider-connection';
import { feeForPayment } from '@/lib/application-fee';
import { recordPayment } from '@/lib/payments';

export type PayRefusal = { code: string; message: string };

export type PayIntent = {
  clientSecret: string;
  publishableKey: string;
  accountId: string;
  amountPennies: number;
  currency: string;
};

/**
 * Who may be charged, and for what. Sentences, not codes — these reach a customer standing at a
 * counter or sitting in a car park. ORDER MATTERS: facts about the DOCUMENT come before facts about
 * our configuration, so a customer is never told "card payments aren't switched on" about an
 * invoice that is void or already settled.
 */
export function refusePayment(doc: InvoiceDoc, balancePennies: number): PayRefusal | null {
  if (doc.status === 'void') {
    return { code: 'void', message: 'This invoice has been cancelled, so there is nothing to pay.' };
  }
  if (doc.underCorrection) {
    return { code: 'under_correction', message: 'The garage is updating this invoice. They’ll send you the new one — there’s nothing to pay yet.' };
  }
  if (doc.series === 'warranty') {
    return { code: 'warranty', message: 'This is a warranty invoice — there’s nothing to pay.' };
  }
  // ── A SETTLED DOCUMENT IS SETTLED, WHATEVER THE LEDGER ARITHMETIC SAYS ──────────────────────
  // Not redundant with the balance test below, and this is the case that makes it necessary: a
  // REFUND subtracts from the cache, so a paid-then-refunded invoice has a positive balance again.
  // Reading balance alone, an old pay link would happily charge a customer a second time for money
  // that was deliberately given back. A refund unwinds a transaction; it does not reinstate a debt.
  // If a garage genuinely wants to re-bill, they void and re-issue, which is an audited act.
  if (doc.status === 'paid' || doc.status === 'settled' || doc.status === 'paid_pending') {
    return { code: 'nothing_owing', message: 'This invoice is already settled — thank you.' };
  }
  if (balancePennies <= 0) {
    return { code: 'nothing_owing', message: 'This invoice is already paid in full — thank you.' };
  }
  return null;
}

/**
 * CAN THIS INVOICE BE PAID BY CARD RIGHT NOW? Answered without creating anything, so the page can
 * decide whether to render a Pay button.
 *
 * Shares refusePayment with the endpoint deliberately. The alternative — the page guessing and the
 * endpoint deciding — produces a button that appears and then immediately refuses, which reads as
 * a broken product rather than as an unavailable option. One rule, two readers, and the page never
 * offers what the endpoint would turn down.
 */
export async function canOfferCardPayment(args: {
  groupId: string;
  doc: InvoiceDoc;
  balancePennies: number;
}): Promise<boolean> {
  if (!getStripe() || !stripePublishableKey()) return false;
  if (refusePayment(args.doc, args.balancePennies)) return false;
  const row = await readConnection(args.groupId, 'stripe');
  return providerState(row).status === 'ready';
}

/**
 * Set up the payment. Throws `PAY:<code>` for conditions the caller turns into a sentence; the
 * Stripe classifier (lib/stripe-errors) handles anything Stripe itself refuses.
 */
export async function createInvoicePaymentIntent(args: {
  groupId: string;
  invoiceId: string;
}): Promise<{ ok: true; intent: PayIntent } | { ok: false; refusal: PayRefusal }> {
  const stripe = getStripe();
  if (!stripe) throw new Error('PAY:not_configured');
  const publishableKey = stripePublishableKey();
  if (!publishableKey) throw new Error('PAY:not_configured');

  const doc = await buildInvoiceDoc(args.invoiceId, args.groupId);
  if (!doc) throw new Error('PAY:invoice_not_found');

  // THE AMOUNT. Frozen lines → total; ledger → received; the difference is what is owed, right now.
  const totalPennies = doc.vatRegistered ? doc.totals.grossPennies : doc.totals.netPennies;
  const inv = (await prisma.invoice.findUnique({
    where: { id: args.invoiceId },
    select: { amount_paid_pennies: true, site_id: true },
  })) as { amount_paid_pennies: number | null; site_id: string } | null;
  if (!inv) throw new Error('PAY:invoice_not_found');
  const balance = balanceOwedPennies(inv, totalPennies);

  const refusal = refusePayment(doc, balance);
  if (refusal) return { ok: false, refusal };

  // The garage's own account must be able to take money. Its own state, not our opinion of it.
  const row = await readConnection(args.groupId, 'stripe');
  const state = providerState(row);
  if (state.status !== 'ready') {
    return { ok: false, refusal: { code: 'not_ready', message: 'This garage can’t take card payments online at the moment. Please contact them to pay another way.' } };
  }

  const currency = (doc.currency || 'GBP').toUpperCase();
  const country = (await prisma.group.findUnique({ where: { id: args.groupId }, select: { tax_country_code: true } }))?.tax_country_code ?? 'GB';
  // THROWS when no rate exists. Deliberate: charging with no rate would take a fee of zero and look
  // exactly like a working integration. See lib/application-fee.
  const { feePennies, rateId } = await feeForPayment(prisma, {
    groupId: args.groupId, country, currency, at: new Date(), amountPennies: balance,
  });

  const pi = await stripe.paymentIntents.create(
    {
      amount: balance,
      currency: currency.toLowerCase(),
      application_fee_amount: feePennies > 0 ? feePennies : undefined,
      automatic_payment_methods: { enabled: true },
      // For a HUMAN reading Stripe's dashboard. Never read back by us — see the header.
      metadata: { greasedesk_invoice_id: args.invoiceId, greasedesk_invoice_number: doc.number },
      // Stripe's own receipt stays OFF (ruling 2026-08-15): we send one, and two receipts for one
      // payment is how a garage gets a phone call.
      description: `Invoice ${doc.displayNumber}`,
    },
    {
      stripeAccount: state.externalId,
      // A refresh or a double-tap must not mint a second PaymentIntent. Keyed on the invoice AND the
      // amount, so a genuinely changed balance is a genuinely new intent rather than a silently
      // stale one.
      idempotencyKey: `inv-pay:${args.invoiceId}:${balance}`,
    },
  );

  // The binding, written server-side. `processing` because nothing has cleared: only the webhook
  // may say otherwise. A redelivered create is a P2002 no-op inside recordPayment.
  await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    await recordPayment(tx, {
      groupId: args.groupId,
      invoiceId: args.invoiceId,
      siteId: inv.site_id,
      amountPennies: balance,
      currency,
      status: 'processing',
      collectedAt: new Date(),
      createdBy: null, // a customer, not a member of staff
      sourceRef: pi.id,
      provider: 'stripe',
    });
    // Fee grain is frozen onto the row the moment it exists, so what was charged stays explicable
    // even if the rate table moves on. recordPayment does not carry these — they are Stripe-only.
    await (tx as any).payment.updateMany({
      where: { source_ref: pi.id },
      data: { payment_intent_id: pi.id, application_fee_pennies: feePennies, fee_rate_id: rateId },
    });
  });

  return {
    ok: true,
    intent: {
      clientSecret: pi.client_secret as string,
      publishableKey,
      accountId: state.externalId,
      amountPennies: balance,
      currency,
    },
  };
}
