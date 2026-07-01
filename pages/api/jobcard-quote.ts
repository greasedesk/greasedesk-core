/**
 * File: pages/api/jobcard-quote.ts
 * Save a job card's quote/estimate (staff-side). POST { jobCardId, vatRate, items[] }.
 * Replace-all + recompute: atomically replaces the card's line items and recomputes/persists the
 * card totals (auto-setting the card value) on every save. Totals are recomputed SERVER-SIDE via
 * lib/quote-totals.ts — client-sent totals are never trusted.
 *
 * Authority (chokepoints): getVisibility + canManageSite — editing a quote (pricing) requires
 * admin/owner (any site) or site-manager (their assigned site). STANDARD users are refused (403).
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { prisma } from '@/lib/db';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/pages/api/auth/[...nextauth]';
import { Prisma, ItemType } from '@prisma/client';
import { getVisibility } from '@/lib/site-visibility';
import { getTenantPermissions, canEditEstimate } from '@/lib/permissions';
import { computeQuoteTotals, poundsToPennies, penniesToPounds, QuoteLineInput, clampVatRate } from '@/lib/quote-totals';

const TYPES: ItemType[] = ['labour', 'part', 'misc'];

type IncomingLine = {
  item_type?: string; description?: string; qty?: number | string;
  unit_price?: number | string; unit_cost?: number | string; vatable?: boolean;
};

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ message: 'Method Not Allowed' });
  }
  const session = await getServerSession(req, res, authOptions);
  const user = session?.user as any;
  if (!user?.id || !user?.group_id) return res.status(401).json({ message: 'Not authenticated.' });

  const { jobCardId, vatRate, items } = (req.body || {}) as { jobCardId?: string; vatRate?: number | string; items?: IncomingLine[] };
  if (!jobCardId) return res.status(400).json({ message: 'Missing jobCardId.' });
  if (!Array.isArray(items)) return res.status(400).json({ message: 'items must be an array.' });

  // Card must be in the caller's group; editing requires authority over its site.
  const card = await prisma.jobCard.findFirst({ where: { id: jobCardId, group_id: user.group_id }, select: { id: true, site_id: true } });
  if (!card) return res.status(404).json({ message: 'Job card not found.' });
  const vis = await getVisibility(user.id as string);
  const perms = await getTenantPermissions(user.group_id as string);
  if (!canEditEstimate(vis, card.site_id, perms)) {
    return res.status(403).json({ message: 'You do not have permission to edit this job card’s estimate.' });
  }

  // Validate + normalise lines.
  const rate = clampVatRate(typeof vatRate === 'string' ? parseFloat(vatRate) : (vatRate ?? 20));
  const inputs: QuoteLineInput[] = [];
  for (const raw of items) {
    const t = String(raw.item_type) as ItemType;
    if (!TYPES.includes(t)) return res.status(400).json({ message: `Invalid item_type: ${raw.item_type}` });
    const num = (v: any) => (v === '' || v == null ? 0 : Number(v));
    if (![raw.qty, raw.unit_price, raw.unit_cost].every((v) => v === undefined || v === '' || v == null || Number.isFinite(Number(v)))) {
      return res.status(400).json({ message: 'qty / unit_price / unit_cost must be numbers.' });
    }
    inputs.push({
      item_type: t,
      qty: num(raw.qty),
      unit_price_pennies: poundsToPennies(num(raw.unit_price)),
      unit_cost_pennies: poundsToPennies(num(raw.unit_cost)),
      vatable: !!raw.vatable,
    });
  }

  const totals = computeQuoteTotals(inputs, rate);

  // Effective per-line values to store (mirror the compute flooring).
  const rows = inputs.map((it, i) => ({
    job_card_id: jobCardId,
    item_type: it.item_type,
    description: String(items[i].description ?? '').trim(),
    qty: new Prisma.Decimal(Math.max(0, it.qty)),
    unit_price: new Prisma.Decimal(penniesToPounds(it.item_type === 'labour' ? Math.max(0, it.unit_price_pennies) : it.unit_price_pennies)),
    unit_cost: new Prisma.Decimal(penniesToPounds(Math.max(0, it.unit_cost_pennies ?? 0))),
    vat_rate: new Prisma.Decimal(it.vatable ? totals.vat_rate : 0),
    vat_amount: new Prisma.Decimal(penniesToPounds(totals.lines[i].vat_pennies)),
  }));

  try {
    await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      await tx.jobCardItem.deleteMany({ where: { job_card_id: jobCardId } });
      if (rows.length) await tx.jobCardItem.createMany({ data: rows });
      await tx.jobCard.update({
        where: { id: jobCardId },
        data: {
          vat_rate: new Prisma.Decimal(totals.vat_rate),
          labour_bill_numeric: new Prisma.Decimal(penniesToPounds(totals.labour_pennies)),
          parts_bill_numeric: new Prisma.Decimal(penniesToPounds(totals.parts_pennies)),
          labour_cost_numeric: new Prisma.Decimal(penniesToPounds(totals.labour_cost_pennies)),
          parts_cost_numeric: new Prisma.Decimal(penniesToPounds(totals.parts_cost_pennies)),
        },
      });
    });
  } catch (e) {
    console.error('quote save error:', e);
    return res.status(500).json({ message: 'Failed to save estimate.' });
  }

  return res.status(200).json({ message: 'Estimate saved.', totals });
}
