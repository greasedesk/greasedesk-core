/**
 * File: pages/api/payments/manual-refund.ts
 * POST { paymentId, amountPennies, reason, paymentMethodId, collectedAt } → record money the
 * GARAGE handed back. Cash from the till, a bank transfer, the card machine on the counter.
 *
 * ── THIS ONE WRITES. THE CARD ONE DOES NOT. ─────────────────────────────────────────────────────
 * pages/api/payments/refund asks Stripe and writes nothing, because Stripe refunds arrive from
 * three directions and the webhook is the single writer for all of them. There is no Stripe here.
 * No external system to ask, no event to wait for — the person at the counter is the only witness,
 * so this records what they say happened, through the same writer and the same reconcile the
 * webhook uses (lib/payments::recordManualRefund).
 *
 * ── THE GUARDS, AND WHY EACH ONE ────────────────────────────────────────────────────────────────
 *  ON THE INVOICE, NEVER A REVENUE SCREEN. A refund is a fact about a document, and the only place
 *    it can be recorded is against the invoice the money came in on.
 *  A PAYMENT ROW TO POINT AT. Refund.payment_id is required by the model, and that constraint is
 *    the structural limit that makes this not a back door: you cannot refund money the ledger never
 *    saw. There is no path here to invent an outflow.
 *  NOT MORE THAN CAME IN. Across the payment, and across several partials — see
 *    lib/refund-eligibility::refuseManualAmount, the same predicate the surface renders from.
 *  MANDATORY REASON AND METHOD. A refund with no stated reason is a hole in the till nobody can
 *    explain in six months; a refund with no method cannot be reconciled against a bank statement.
 *  A DATE, DEFAULTING TO TODAY BUT EDITABLE. Handed over Friday, recorded Tuesday: the money moved
 *    on FRIDAY, and that is the VAT-relevant date.
 *  THE SAME REFUSAL refuseIfVoid GIVES. A void invoice retains its document and refuses every money
 *    movement — one rule across nine paths, not a ninth opinion here.
 *  MANAGER AND ABOVE. The same bar as issuing, unlocking and card refunds: canManageSite is where
 *    money decisions already live.
 *
 * ── TWO FACTS, TWO ROWS ─────────────────────────────────────────────────────────────────────────
 * `refund.requested` carries WHO — a person at the garage decided this. The Refund row carries the
 * MONEY. They are different facts and neither substitutes for the other; the audit row has a
 * user_id and the ledger row is the ledger.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { prisma } from '@/lib/db';
import { requireTenantApi, canManageSite } from '@/lib/admin-guard';
import { refuseIfVoid } from '@/lib/invoice-void';
import { refundableForPayment, refuseManualAmount } from '@/lib/refund-eligibility';
import { recordManualRefund } from '@/lib/payments';
import { writeAudit } from '@/lib/audit';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).json({ message: 'Method Not Allowed' }); }
  const scope = await requireTenantApi(req, res);
  if (!scope) return;

  const body = (req.body ?? {}) as Record<string, unknown>;
  const paymentId = String(body.paymentId ?? '');
  const amountPennies = Math.round(Number(body.amountPennies));
  const reason = String(body.reason ?? '').trim();
  const paymentMethodId = String(body.paymentMethodId ?? '');
  const collectedAtRaw = String(body.collectedAt ?? '');

  const pay = (await prisma.payment.findFirst({
    where: { id: paymentId, group_id: scope.groupId },
    select: {
      id: true, site_id: true, provider: true, status: true, amount_pennies: true, currency: true,
      collected_at: true, payment_method_snapshot: true,
      refunds: { select: { amount_pennies: true } },
      invoice: { select: { id: true, invoice_number: true, job_card_id: true, status: true } },
    },
  })) as any;
  // The required payment row IS the guard. A missing one is not "invalid input" — it is the
  // attempt to refund money the ledger never saw, refused by construction.
  if (!pay) return res.status(404).json({ code: 'no_payment', message: 'That payment isn’t on this invoice, so there’s nothing to refund against it.' });
  if (!pay.invoice) return res.status(409).json({ code: 'no_invoice', message: 'That payment isn’t attached to an invoice.' });

  if (!canManageSite(scope.vis, pay.site_id)) {
    return res.status(403).json({ code: 'not_permitted', message: 'Recording a refund needs manager access for this location.' });
  }

  const voided = refuseIfVoid(pay.invoice);
  if (voided) return res.status(409).json({ ...voided });

  // A CARD payment is not ours to hand back at the counter — it goes back the way it came, or the
  // two ledgers disagree and Stripe's is the one the customer's bank believes.
  if (pay.provider === 'stripe') {
    return res.status(409).json({
      code: 'is_card',
      message: 'This was paid by card online, so it has to be refunded back to the card rather than recorded by hand.',
    });
  }

  if (!reason) return res.status(400).json({ code: 'reason_required', message: 'Say why this was refunded — it’s what makes the till explainable later.' });
  if (reason.length > 300) return res.status(400).json({ code: 'reason_too_long', message: 'Keep the reason under 300 characters.' });

  const method = (await prisma.paymentMethod.findFirst({
    where: { id: paymentMethodId, group_id: scope.groupId },
    select: { id: true, name: true },
  })) as any;
  if (!method) return res.status(400).json({ code: 'method_required', message: 'Choose how the money went back.' });

  // The date the money MOVED. Absent → today; present → taken as given, but never in the future,
  // because a refund cannot have happened tomorrow.
  const collectedAt = collectedAtRaw ? new Date(`${collectedAtRaw}T12:00:00.000Z`) : new Date();
  if (Number.isNaN(collectedAt.getTime())) return res.status(400).json({ code: 'bad_date', message: 'That date isn’t valid.' });
  if (collectedAt.getTime() > Date.now() + 86_400_000) {
    return res.status(400).json({ code: 'future_date', message: 'A refund can’t be dated in the future.' });
  }

  // THE CAP — the same predicate the surface rendered from, re-derived here and never taken from
  // the page: a browser open since this morning may be quoting a payment that has since been
  // part-refunded.
  const line = refundableForPayment(pay);
  const refusal = refuseManualAmount(line, amountPennies);
  if (refusal) return res.status(409).json({ ...refusal });

  const created = await prisma.$transaction(async (tx: any) => {
    const row = await recordManualRefund(tx, {
      groupId: scope.groupId,
      paymentId: pay.id,
      invoiceId: pay.invoice.id,
      amountPennies,
      currency: pay.currency,
      reason,
      paymentMethodId: method.id,
      paymentMethodSnapshot: method.name,
      collectedAt,
      createdBy: scope.userId,
    });
    // Inside the transaction: the money and the record of who moved it commit together or not at
    // all. (The card path audits outside, because there the money moves at Stripe and the ledger
    // catches up later — here they are the same act.)
    await writeAudit(tx, {
      groupId: scope.groupId, userId: scope.userId, jobCardId: pay.invoice.job_card_id ?? null,
      action: 'refund.requested',
      diff: {
        invoice: pay.invoice.invoice_number ?? null, paymentId: pay.id, refundId: row.id,
        amountPennies, partial: amountPennies < line.remainingPennies,
        origin: 'manual', method: method.name, reason,
        collectedAt: collectedAt.toISOString().slice(0, 10),
      },
    });
    return row;
  });

  return res.status(200).json({
    ok: true, refundId: created.id, amountPennies,
    message: `£${(amountPennies / 100).toFixed(2)} recorded as refunded.`,
  });
}
