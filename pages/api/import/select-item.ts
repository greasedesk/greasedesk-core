/**
 * File: pages/api/import/select-item.ts
 * ADMIN-only. Attach an EXISTING CatalogueItem to a staged line, and remember the decision.
 *
 * Two effects, both deliberate:
 *   1. The line inherits cost and labour hours FROM THE CATALOGUE — they are never re-typed, so an
 *      imported line can never disagree with the product it is an instance of. (This is also the
 *      cost boundary: the browser sends an item id, not a trade cost.)
 *   2. A CatalogueAlias is written for description + unit_price, and the mapping is applied
 *      RETROACTIVELY across every PENDING staged line in the tenant with that same description and
 *      price — not just the ones reached afterwards. Deciding once settles all 42 invoices.
 *
 * Committed invoices are never touched: their lines are frozen at issue.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import { requireImportApi, importableSiteIds } from '@/lib/admin-guard';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ message: 'Method Not Allowed' });
  }
  const vis = await requireImportApi(req, res);
  if (!vis) return;
  if (!vis.groupId) return res.status(403).json({ message: 'You do not have permission to import invoices.' });

  const { lineId, catalogueItemId, clear } = (req.body || {}) as {
    lineId?: string; catalogueItemId?: string; clear?: boolean;
  };
  if (!lineId) return res.status(400).json({ message: 'lineId is required.' });

  const line = await prisma.stagedLine.findFirst({
    where: { id: lineId, staged_invoice: { group_id: vis.groupId } },
    select: { id: true, description: true, unit_price: true, is_adjustment: true,
      staged_invoice: { select: { batch: { select: { site_id: true } } } } },
  });
  if (!line) return res.status(404).json({ message: 'Line not found.' });
  if (line.is_adjustment) return res.status(400).json({ message: 'Adjustments carry no catalogue item.' });
  if (!importableSiteIds(vis).includes(line.staged_invoice.batch.site_id)) {
    return res.status(403).json({ message: 'That batch belongs to a location you do not work in.' });
  }

  // ── CLEAR: detach and forget the alias, so a mistaken choice does not persist across the batch ──
  if (clear) {
    const n = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      await tx.catalogueAlias.deleteMany({
        where: { group_id: vis.groupId as string, description: line.description, unit_price: line.unit_price },
      });
      const r = await tx.stagedLine.updateMany({
        where: {
          description: line.description, unit_price: line.unit_price,
          staged_invoice: { group_id: vis.groupId as string, status: { in: ['pending', 'in_progress'] } },
        },
        data: { catalogue_item_id: null, parts_cost: null, labour_hours: null, cost_basis: null },
      });
      return r.count;
    });
    return res.status(200).json({ message: 'Cleared.', applied: n });
  }

  if (!catalogueItemId) return res.status(400).json({ message: 'catalogueItemId is required.' });

  const item = await prisma.catalogueItem.findFirst({
    where: { id: catalogueItemId, group_id: vis.groupId },
    select: { id: true, title: true, name: true, item_type: true, unit_cost: true, labour_hours: true },
  });
  if (!item) return res.status(404).json({ message: 'Catalogue item not found.' });

  const applied = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    // Remember the mapping for next time (and for any future batch).
    await tx.catalogueAlias.upsert({
      where: {
        group_id_description_unit_price: {
          group_id: vis.groupId as string, description: line.description, unit_price: line.unit_price,
        },
      },
      create: {
        group_id: vis.groupId as string, catalogue_item_id: item.id,
        description: line.description, unit_price: line.unit_price, source: 'manual',
      },
      update: { catalogue_item_id: item.id, source: 'manual' },
    });

    // RETROACTIVE: every pending occurrence across the whole tenant's staging, not just this one.
    const r = await tx.stagedLine.updateMany({
      where: {
        description: line.description,
        unit_price: line.unit_price,
        is_adjustment: false,
        staged_invoice: { group_id: vis.groupId as string, status: { in: ['pending', 'in_progress'] } },
      },
      data: {
        catalogue_item_id: item.id,
        kind: item.item_type,
        // Cost and hours come FROM the catalogue — inherited, never re-entered.
        parts_cost: item.unit_cost as any,
        labour_hours: (item.labour_hours ?? null) as any,
        cost_basis: 'actual', // it is the product's own recorded cost, not an estimate
      },
    });
    return r.count;
  });

  return res.status(200).json({
    message: `Applied to ${applied} line${applied === 1 ? '' : 's'} across the batch.`,
    applied,
    item: { id: item.id, label: item.title || item.name },
  });
}
