/**
 * File: pages/api/invoice.ts
 * Edit an issued invoice's lines (corrections + the manual parts roll-up — line granularity may
 * differ from the card; no auto-grouping). PATCH { invoiceId, lines: [...] } replaces all lines and
 * recomputes VAT/totals via the chokepoints. Guards (server-enforced):
 *   - manager/admin over the invoice's site (canManageSite)
 *   - canEditInvoice(invoice) — false once paid → 409 (freeze-on-paid)
 * The invoice number is untouched here (sticky). unit_cost is internal (margin) — accepted but never
 * rendered to the customer.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/pages/api/auth/[...nextauth]';
import { getVisibility } from '@/lib/site-visibility';
import { canManageSite } from '@/lib/admin-guard';
import { canEditInvoice, computeInvoiceLinePennies } from '@/lib/invoice';
import { poundsToPennies, penniesToPounds } from '@/lib/quote-totals';

type IncomingLine = { description?: string; qty?: number | string; unitPrice?: number | string; vatRate?: number | string; unitCost?: number | string };

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'PATCH') {
    res.setHeader('Allow', 'PATCH');
    return res.status(405).json({ message: 'Method Not Allowed' });
  }
  const session = await getServerSession(req, res, authOptions);
  const user = session?.user as any;
  if (!user?.id || !user?.group_id) return res.status(401).json({ message: 'Not authenticated.' });

  const { invoiceId, lines } = (req.body || {}) as { invoiceId?: string; lines?: IncomingLine[] };
  if (!invoiceId) return res.status(400).json({ message: 'Missing invoiceId.' });
  if (!Array.isArray(lines)) return res.status(400).json({ message: 'lines must be an array.' });

  const invoice = (await prisma.invoice.findFirst({
    where: { id: invoiceId, group_id: user.group_id },
    select: { id: true, site_id: true, status: true, vat_registered_at_issue: true },
  })) as { id: string; site_id: string; status: string; vat_registered_at_issue: boolean } | null;
  if (!invoice) return res.status(404).json({ message: 'Invoice not found.' });

  const vis = await getVisibility(user.id as string);
  if (!canManageSite(vis, invoice.site_id)) {
    return res.status(403).json({ message: 'Only a manager or admin can edit an invoice.' });
  }
  if (!canEditInvoice(invoice)) {
    return res.status(409).json({ message: 'This invoice is paid and can no longer be edited.' });
  }

  // unit_cost is INTERNAL (never sent to the client, so the editor can't echo it back). Preserve it
  // by POSITION when the client doesn't supply one — position-preserving corrections keep their
  // margin; a manual roll-up that changes the line count loses the granular cost by nature.
  const existing = (await prisma.invoiceLine.findMany({
    where: { invoice_id: invoice.id }, orderBy: { position: 'asc' }, select: { unit_cost: true },
  })) as Array<{ unit_cost: unknown }>;

  // Validate + recompute every line through the chokepoint (VAT honours vat_registered_at_issue).
  const num = (v: any) => (v === '' || v == null ? 0 : Number(v));
  const rows: Prisma.InvoiceLineCreateManyInput[] = [];
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const description = String(raw.description ?? '').trim();
    if (!description) return res.status(400).json({ message: `Line ${i + 1}: description is required.` });
    if (![raw.qty, raw.unitPrice, raw.vatRate, raw.unitCost].every((v) => v === undefined || v === '' || v == null || Number.isFinite(Number(v)))) {
      return res.status(400).json({ message: `Line ${i + 1}: qty / price / rate must be numbers.` });
    }
    const qty = Math.max(0, num(raw.qty));
    const pricePennies = poundsToPennies(num(raw.unitPrice));
    const rate = Math.min(100, Math.max(0, num(raw.vatRate)));
    const { netPennies, vatPennies } = computeInvoiceLinePennies(qty, pricePennies, rate, invoice.vat_registered_at_issue);
    const costProvided = raw.unitCost !== undefined && raw.unitCost !== null && raw.unitCost !== '';
    const unitCostPounds = costProvided ? penniesToPounds(poundsToPennies(num(raw.unitCost))) : Number(existing[i]?.unit_cost ?? 0);
    rows.push({
      invoice_id: invoice.id,
      description,
      qty: new Prisma.Decimal(qty.toFixed(2)),
      unit_price: new Prisma.Decimal(penniesToPounds(pricePennies).toFixed(2)),
      vat_rate: new Prisma.Decimal((invoice.vat_registered_at_issue ? rate : 0).toFixed(2)),
      line_vat: new Prisma.Decimal(penniesToPounds(vatPennies).toFixed(2)),
      line_total: new Prisma.Decimal(penniesToPounds(netPennies).toFixed(2)),
      unit_cost: new Prisma.Decimal(unitCostPounds.toFixed(2)),
      position: i,
    });
  }

  try {
    await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      await tx.invoiceLine.deleteMany({ where: { invoice_id: invoice.id } });
      if (rows.length) await tx.invoiceLine.createMany({ data: rows });
    });
  } catch (e) {
    console.error('Invoice edit error:', e);
    return res.status(500).json({ message: 'Failed to save invoice.' });
  }
  return res.status(200).json({ message: 'Invoice updated.' });
}
