/**
 * File: pages/api/payments/refundable.ts
 * GET ?jobCardId= → what can be refunded on this job, decided SERVER-SIDE.
 *
 * The panel renders from this and never works it out itself. That is the rule the Pay button broke
 * once — the page decided one way, the endpoint decided another, and a customer saw a Pay button
 * beside "card payment isn't available for this invoice". Both the surface and the two refund
 * endpoints now read lib/refund-eligibility, so a control that appears is a control that works.
 *
 * Read-only. `canManage` is returned rather than assumed, so the panel can say "manager access
 * needed" instead of rendering controls that will 403.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { prisma } from '@/lib/db';
import { requireTenantApi, canManageSite } from '@/lib/admin-guard';
import { refuseIfVoid } from '@/lib/invoice-void';
import { refundPosition } from '@/lib/refund-eligibility';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET') { res.setHeader('Allow', 'GET'); return res.status(405).json({ message: 'Method Not Allowed' }); }
  const scope = await requireTenantApi(req, res);
  if (!scope) return;

  const jobCardId = String(req.query.jobCardId ?? '');
  if (!jobCardId) return res.status(400).json({ message: 'Missing jobCardId.' });

  const card = (await prisma.jobCard.findFirst({
    where: { id: jobCardId, group_id: scope.groupId },
    select: { id: true, site_id: true },
  })) as any;
  if (!card) return res.status(404).json({ message: 'Job card not found.' });

  const invoice = (await prisma.invoice.findFirst({
    where: { job_card_id: jobCardId, group_id: scope.groupId },
    select: { id: true, status: true, invoice_number: true },
  })) as any;

  const payments = invoice
    ? ((await prisma.payment.findMany({
        where: { invoice_id: invoice.id },
        orderBy: { collected_at: 'asc' },
        select: {
          id: true, provider: true, status: true, amount_pennies: true, currency: true,
          collected_at: true, payment_method_snapshot: true,
          application_fee_pennies: true, stripe_fee_pennies: true,
          refunds: { select: { amount_pennies: true, application_fee_refunded_pennies: true } },
        },
      })) as any[])
    : [];

  const position = refundPosition(payments, invoice, invoice ? refuseIfVoid(invoice) : null);
  const methods = await prisma.paymentMethod.findMany({
    where: { group_id: scope.groupId, active: true },
    orderBy: { name: 'asc' }, select: { id: true, name: true },
  });

  return res.status(200).json({
    canManage: canManageSite(scope.vis, card.site_id),
    invoiceNumber: invoice?.invoice_number ?? null,
    invoiceRefusal: position.invoiceRefusal,
    totalRemainingPennies: position.totalRemainingPennies,
    payments: position.lines.map((l, i) => ({
      ...l,
      collectedAt: l.collectedAt.toISOString(),
      applicationFeePennies: payments[i]?.application_fee_pennies ?? null,
      stripeFeePennies: payments[i]?.stripe_fee_pennies ?? null,
      applicationFeeAlreadyReturnedPennies: (payments[i]?.refunds ?? [])
        .reduce((a: number, r: any) => a + (r.application_fee_refunded_pennies ?? 0), 0),
    })),
    methods,
    // The server's today, so a till with a wrong clock cannot date a refund by accident.
    today: new Date().toISOString().slice(0, 10),
  });
}
