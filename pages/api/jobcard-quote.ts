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
import { getTenantPermissions, canEditEstimate, financeVisibility } from '@/lib/permissions';
import { getTenantVat } from '@/lib/tenant-vat';
import { requireCanWrite } from '@/lib/admin-guard';
import { canEditInvoice } from '@/lib/invoice';
import { computeQuoteTotals, poundsToPennies, penniesToPounds, QuoteLineInput, clampVatRate } from '@/lib/quote-totals';

const TYPES: ItemType[] = ['labour', 'part', 'misc', 'fixed'];

type IncomingLine = {
  item_type?: string; description?: string; qty?: number | string;
  unit_price?: number | string; unit_cost?: number | string; vatable?: boolean;
  catalogue_item_id?: string | null; // origin hook (tenant-validated below)
  labour_hours?: number | string | null; // fixed lines: charged labour content (from the service)
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
  const card = (await prisma.jobCard.findFirst({
    where: { id: jobCardId, group_id: user.group_id },
    select: { id: true, site_id: true, invoice: { select: { status: true, invoice_number: true, lines: { select: { id: true }, take: 1 } } } },
  })) as any;
  if (!card) return res.status(404).json({ message: 'Job card not found.' });
  const vis = await getVisibility(user.id as string);
  const perms = await getTenantPermissions(user.group_id as string);
  if (!canEditEstimate(vis, card.site_id, perms)) {
    return res.status(403).json({ message: 'You do not have permission to edit this job card’s estimate.' });
  }
  // FREEZE-AT-ISSUE: once the invoice's lines are frozen (at mint), the estimate is locked — the
  // card is the working draft only until issue. The only escape hatch is the audited ADMIN unlock
  // (which deletes the frozen lines; their absence IS the unlocked state) — never a direct edit.
  if (card.invoice && !canEditInvoice({ status: card.invoice.status, hasFrozenLines: (card.invoice.lines?.length ?? 0) > 0 })) {
    return res.status(409).json({ message: 'This job is invoiced and its lines are frozen. An admin can unlock it to make corrections.' });
  }
  if (!(await requireCanWrite(user.group_id as string, res))) return; // lapsed = read-only; saving an estimate is new work

  // Master switch + company default rate (the fallback when the client omits a rate).
  const vat = await getTenantVat(user.group_id as string);
  const rate = clampVatRate(typeof vatRate === 'string' ? parseFloat(vatRate) : (vatRate ?? vat.defaultRate));

  // COST AUTHORITY: only a cost-visible caller (seeMargin — ADMIN always) may assert an ad-hoc line's
  // cost. For everyone else the server keeps ignoring client cost and preserves the existing value.
  // Catalogue-linked lines ALWAYS inherit the product cost regardless of who saves (see below).
  const fin = financeVisibility(vis, perms);

  let saved;
  try {
    saved = await performEstimateSave({ groupId: user.group_id as string, jobCardId, items, vatRate: rate, vatRegistered: vat.registered, costWritable: fin.seeMargin });
  } catch (e: any) {
    if (e?.message?.startsWith('VALIDATION:')) return res.status(400).json({ message: e.message.slice('VALIDATION:'.length) });
    console.error('quote save error:', e);
    return res.status(500).json({ message: 'Failed to save estimate.' });
  }

  // Cost figures are the MARGIN grain — stripped from the response unless the saver is
  // cost-visible (same rule as the shaped page props: absent, not hidden).
  const totals: any = { ...saved.totals };
  if (!fin.seeMargin) { delete totals.labour_cost_pennies; delete totals.parts_cost_pennies; }
  return res.status(200).json({ message: 'Estimate saved.', totals });
}

/**
 * THE estimate save core (exported for the proof matrix — the matrix drives the REAL write path).
 * unit_cost is SERVER-RESOLVED, never blindly trusted from the browser (ruling 2026-07-12). Resolution:
 *   product-linked line → the catalogue product's unit_cost (server-derived, like labour_outsourced;
 *                         frozen per line at save). The client cost is IGNORED — the catalogue is the
 *                         cost home — regardless of who saves.
 *   ad-hoc line, costWritable caller → the client-sent unit_cost (validated ≥0). Only a cost-visible
 *                         caller (seeMargin — ADMIN always) reaches this; STANDARD/price-only users
 *                         never send nor set cost. This is the 2026-07-17 reopening of ad-hoc cost
 *                         capture WITHOUT reopening the leak: the authority is re-checked server-side.
 *   ad-hoc line, non-cost caller → the existing line's cost, matched by exact (item_type, description),
 *                         consumed once (preserves a cost a cost-visible user set earlier; a rename
 *                         resets the match to 0).
 */
export async function performEstimateSave(args: { groupId: string; jobCardId: string; items: any[]; vatRate: number; vatRegistered: boolean; costWritable?: boolean }) {
  const { groupId, jobCardId, items, vatRate, vatRegistered, costWritable = false } = args;

  // Validate catalogue origin ids against THIS tenant's catalogue — unknown/foreign ids drop to
  // null (SetNull-safe) — and read the SERVER truths inherited per line: outsourced flag + cost.
  const sentIds = Array.from(new Set(items.map((it) => (typeof it.catalogue_item_id === 'string' ? it.catalogue_item_id : '')).filter(Boolean)));
  const validIds = new Set<string>();
  const outsourcedIds = new Set<string>();
  const costById = new Map<string, number>();
  if (sentIds.length) {
    const found = (await prisma.catalogueItem.findMany({ where: { id: { in: sentIds }, group_id: groupId }, select: { id: true, labour_outsourced: true, unit_cost: true } })) as any[];
    found.forEach((f) => { validIds.add(f.id); if (f.labour_outsourced) outsourcedIds.add(f.id); costById.set(f.id, Number(f.unit_cost ?? 0)); });
  }
  // Existing lines: the preservation pool for ad-hoc costs (exact type+description, consumed once).
  const existing = (await prisma.jobCardItem.findMany({
    where: { job_card_id: jobCardId },
    select: { item_type: true, description: true, unit_cost: true },
    orderBy: { created_at: 'asc' },
  })) as any[];
  const pool = existing.map((e) => ({ key: `${e.item_type}||${String(e.description ?? '').trim()}`, cost: Number(e.unit_cost ?? 0) }));
  const takeExisting = (itemType: string, description: string): number => {
    const k = `${itemType}||${description}`;
    const i = pool.findIndex((p) => p.key === k);
    if (i < 0) return 0;
    return pool.splice(i, 1)[0].cost;
  };

  // Validate + normalise lines, resolving unit_cost SERVER-SIDE (client cost ignored entirely).
  const inputs: QuoteLineInput[] = [];
  const resolved: Array<{ description: string; catalogueItemId: string | null; outsourced: boolean; labourHours: Prisma.Decimal | null }> = [];
  for (const raw of items) {
    const t = String(raw.item_type) as ItemType;
    if (!TYPES.includes(t)) throw new Error(`VALIDATION:Invalid item_type: ${raw.item_type}`);
    const num = (v: any) => (v === '' || v == null ? 0 : Number(v));
    if (![raw.qty, raw.unit_price].every((v) => v === undefined || v === '' || v == null || Number.isFinite(Number(v)))) {
      throw new Error('VALIDATION:qty / unit_price must be numbers.');
    }
    const description = String(raw.description ?? '').trim();
    const catalogueItemId = (typeof raw.catalogue_item_id === 'string' && validIds.has(raw.catalogue_item_id)) ? (raw.catalogue_item_id as string) : null;
    // Catalogue-linked → inherit product cost (client cost ignored). Ad-hoc → a cost-visible caller
    // may assert it (validated ≥0); anyone else preserves the existing cost by type+description.
    const costPounds = catalogueItemId != null
      ? (costById.get(catalogueItemId) ?? 0)
      : (costWritable ? Math.max(0, num(raw.unit_cost)) : takeExisting(t, description));
    inputs.push({
      item_type: t,
      qty: num(raw.qty),
      unit_price_pennies: poundsToPennies(num(raw.unit_price)),
      unit_cost_pennies: poundsToPennies(Math.max(0, costPounds)), // server-resolved — feeds the numerics too
      vatable: !!raw.vatable,
    });
    resolved.push({
      description,
      catalogueItemId,
      outsourced: catalogueItemId != null && outsourcedIds.has(catalogueItemId),
      labourHours: (() => { const v = raw.labour_hours; if (v === undefined || v === null || v === '') return null; const n = Number(v); return Number.isFinite(n) && n >= 0 && n <= 1000 ? new Prisma.Decimal(n.toFixed(2)) : null; })(),
    });
  }

  // Master switch: a non-registered tenant gets no VAT anywhere, regardless of per-line flags.
  const totals = computeQuoteTotals(inputs, vatRate, { vatRegistered });

  // Effective per-line values to store (mirror the compute flooring).
  const rows = inputs.map((it, i) => ({
    job_card_id: jobCardId,
    item_type: it.item_type,
    description: resolved[i].description,
    qty: new Prisma.Decimal(Math.max(0, it.qty)),
    unit_price: new Prisma.Decimal(penniesToPounds(it.item_type === 'labour' ? Math.max(0, it.unit_price_pennies) : it.unit_price_pennies)),
    unit_cost: new Prisma.Decimal(penniesToPounds(Math.max(0, it.unit_cost_pennies ?? 0))), // server-resolved above
    vat_rate: new Prisma.Decimal(it.vatable ? totals.vat_rate : 0),
    vat_amount: new Prisma.Decimal(penniesToPounds(totals.lines[i].vat_pennies)),
    catalogue_item_id: resolved[i].catalogueItemId,
    // Inherited from the product AT SAVE (server-derived, never client-sent): frozen per line, so
    // re-flagging a product later never rewrites history.
    labour_outsourced: resolved[i].outsourced,
    // Fixed lines carry the service's charged labour content (validated non-negative number or null).
    labour_hours: resolved[i].labourHours,
  }));

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

  return { totals };
}
