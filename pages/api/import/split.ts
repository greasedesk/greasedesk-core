/**
 * File: pages/api/import/split.ts
 * ADMIN-only. Split a bundled staged line into constituents — or clear a split.
 *
 *   POST { lineId, children: [{ description, qty, unitPrice, kind?, catalogueItemId?,
 *                               partsCost?, labourHours? }] }
 *   POST { lineId, clear: true }
 *
 * REFUSES an unbalanced split (see lib/import-split). The children must sum to the parent's printed
 * amount to the penny; a split re-expresses the invoice and may never change it.
 *
 * RETROACTIVE, exactly as aliasing is: the shape is stored as a LineSplitTemplate keyed on
 * description + unit_price and applied to every PENDING occurrence across the batch. Splitting a
 * bundle once settles every later appearance of it.
 *
 * STAGING ONLY. Children live on StagedLine and reach the ledger only at commit, where they are
 * emitted INSTEAD OF their parent.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import { requireAdminApi } from '@/lib/admin-guard';
import { balanceSplit, describeImbalance, type SplitChildInput } from '@/lib/import-split';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ message: 'Method Not Allowed' });
  }
  const vis = await requireAdminApi(req, res);
  if (!vis) return;
  if (!vis.groupId) return res.status(403).json({ message: 'Admin access required.' });

  const { lineId, children, clear } = (req.body || {}) as {
    lineId?: string; children?: SplitChildInput[]; clear?: boolean;
  };
  if (!lineId) return res.status(400).json({ message: 'lineId is required.' });

  const parent = await prisma.stagedLine.findFirst({
    where: { id: lineId, staged_invoice: { group_id: vis.groupId } },
    select: {
      id: true, description: true, unit_price: true, amount: true, position: true,
      staged_invoice_id: true, parent_line_id: true, is_adjustment: true,
      staged_invoice: { select: { status: true } },
    },
  });
  if (!parent) return res.status(404).json({ message: 'Line not found.' });
  if (parent.parent_line_id) return res.status(400).json({ message: 'A split child cannot itself be split.' });
  if (parent.is_adjustment) return res.status(400).json({ message: 'Adjustments are not split.' });
  if (parent.staged_invoice.status === 'committed') {
    return res.status(409).json({ message: 'This invoice is committed; its lines are frozen.' });
  }

  // ── CLEAR: drop the children here and forget the template, retroactively ─────────────────────
  if (clear) {
    const n = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      await tx.lineSplitTemplate.deleteMany({
        where: { group_id: vis.groupId as string, description: parent.description, unit_price: parent.unit_price },
      });
      const siblings = await tx.stagedLine.findMany({
        where: {
          description: parent.description, unit_price: parent.unit_price, parent_line_id: null,
          staged_invoice: { group_id: vis.groupId as string, status: { in: ['pending', 'in_progress'] } },
        },
        select: { id: true },
      });
      const r = await tx.stagedLine.deleteMany({ where: { parent_line_id: { in: siblings.map((s) => s.id) } } });
      return r.count;
    });
    return res.status(200).json({ message: `Split cleared (${n} child line(s) removed).`, removed: n });
  }

  // ── VALIDATE ────────────────────────────────────────────────────────────────────────────────
  const kids = (children ?? []).filter((c) => c && c.description?.trim());
  const bal = balanceSplit(Number(parent.amount), kids);
  const bad = describeImbalance(bal);
  if (bad) return res.status(400).json({ message: bad, balance: bal });

  // ── SAVE + APPLY RETROACTIVELY ──────────────────────────────────────────────────────────────
  const applied = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    await tx.lineSplitTemplate.upsert({
      where: {
        group_id_description_unit_price: {
          group_id: vis.groupId as string, description: parent.description, unit_price: parent.unit_price,
        },
      },
      create: {
        group_id: vis.groupId as string, description: parent.description,
        unit_price: parent.unit_price, children_json: kids as any,
      },
      update: { children_json: kids as any },
    });

    // Every PENDING occurrence of this description + price across the batch.
    const targets = await tx.stagedLine.findMany({
      where: {
        description: parent.description, unit_price: parent.unit_price,
        parent_line_id: null, is_adjustment: false,
        staged_invoice: { group_id: vis.groupId as string, status: { in: ['pending', 'in_progress'] } },
      },
      select: { id: true, amount: true, staged_invoice_id: true, position: true },
    });

    let n = 0;
    for (const t of targets) {
      // Only apply where the template actually balances THIS parent — a same-description line at a
      // different quantity would otherwise silently import a wrong breakdown.
      if (!balanceSplit(Number(t.amount), kids).ok) continue;
      await tx.stagedLine.deleteMany({ where: { parent_line_id: t.id } });
      await tx.stagedLine.createMany({
        data: kids.map((c, i) => ({
          staged_invoice_id: t.staged_invoice_id,
          parent_line_id: t.id,
          position: t.position * 100 + i + 1,
          description: c.description.trim(),
          qty: c.qty as any,
          unit_price: c.unitPrice as any,
          amount: (Math.round(c.qty * c.unitPrice * 100) / 100) as any,
          kind: (c.kind ?? null) as any,
          catalogue_item_id: c.catalogueItemId ?? null,
          parts_cost: (c.partsCost ?? null) as any,
          labour_hours: (c.labourHours ?? null) as any,
          cost_basis: c.partsCost != null || c.labourHours != null ? 'actual' : null,
          is_adjustment: false,
        })),
      });
      n++;
    }
    return n;
  });

  return res.status(200).json({
    message: `Split saved and applied to ${applied} line${applied === 1 ? '' : 's'} across the batch.`,
    applied,
    balance: bal,
  });
}
