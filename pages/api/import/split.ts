/**
 * File: pages/api/import/split.ts
 * ADMIN-only. Split a bundled staged line into constituents — or clear a split.
 *
 *   POST { lineId, children: [{ description, qty, amount, kind?, catalogueItemId?,
 *                               partsCost?, labourHours? }], expectedChildIds }
 *   POST { lineId, children, replace: true, expectedChildIds }  → replace an existing split
 *   POST { lineId, clear: true }
 *
 * AMOUNT-FIRST: a child is entered as a LINE TOTAL and its unit price is derived (lib/import-split).
 * The invariant is on totals, so collecting anything else forced the total to be reverse-engineered
 * — and for some parent/qty pairs no unit price lands on it at all.
 *
 * NO SILENT OVERWRITE. A save against a line that already has children is refused unless `replace`
 * is set, and refused again if `expectedChildIds` does not match what is actually stored — the
 * caller must have been looking at the split it means to replace. Every outcome is audited
 * (created / replaced / cleared) WITH the child shape, so a lost split can be reconstructed.
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
import { writeImportAudit } from '@/lib/audit';
import {
  balanceSplit, describeImbalance, numOrNull, childAmountPennies, childUnitPrice,
  type SplitChildInput,
} from '@/lib/import-split';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ message: 'Method Not Allowed' });
  }
  const vis = await requireAdminApi(req, res);
  if (!vis) return;
  if (!vis.groupId) return res.status(403).json({ message: 'Admin access required.' });

  const { lineId, children, clear, replace, expectedChildIds } = (req.body || {}) as {
    lineId?: string; children?: SplitChildInput[]; clear?: boolean;
    replace?: boolean; expectedChildIds?: string[];
  };
  if (!lineId) return res.status(400).json({ message: 'lineId is required.' });

  const parent = await prisma.stagedLine.findFirst({
    where: { id: lineId, staged_invoice: { group_id: vis.groupId } },
    select: {
      id: true, description: true, unit_price: true, amount: true, position: true,
      staged_invoice_id: true, parent_line_id: true, is_adjustment: true,
      staged_invoice: { select: { status: true, external_number: true, batch_id: true } },
    },
  });
  if (!parent) return res.status(404).json({ message: 'Line not found.' });
  if (parent.parent_line_id) return res.status(400).json({ message: 'A split child cannot itself be split.' });
  if (parent.is_adjustment) return res.status(400).json({ message: 'Adjustments are not split.' });
  if (parent.staged_invoice.status === 'committed') {
    return res.status(409).json({ message: 'This invoice is committed; its lines are frozen.' });
  }

  // WHAT IS THERE NOW. Every branch below needs it: to refuse a silent overwrite, to detect a stale
  // client, and to record in the audit what was destroyed.
  const existing = await prisma.stagedLine.findMany({
    where: { parent_line_id: parent.id },
    orderBy: { position: 'asc' },
    select: { id: true, description: true, qty: true, amount: true, kind: true, parts_cost: true, labour_hours: true },
  });
  type ExistingChild = (typeof existing)[number];
  const shapeOf = (rows: ExistingChild[]) => rows.map((k: ExistingChild) => ({
    description: k.description, qty: Number(k.qty), amount: Number(k.amount),
    kind: k.kind, partsCost: k.parts_cost == null ? null : Number(k.parts_cost),
    labourHours: k.labour_hours == null ? null : Number(k.labour_hours),
  }));

  // ── CLEAR: drop the children here and forget the template, retroactively ─────────────────────
  if (clear) {
    const previous = shapeOf(existing);
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
      await writeImportAudit(tx, {
        groupId: vis.groupId as string, actorUserId: vis.userId, batchId: parent.staged_invoice.batch_id,
        action: 'import.split_cleared',
        diff: {
          external_ref: parent.staged_invoice.external_number, line: parent.description,
          previous, removed: r.count, siblingsAffected: siblings.length,
        },
      });
      return r.count;
    });
    return res.status(200).json({ message: `Split cleared (${n} child line(s) removed).`, removed: n });
  }

  // ── NORMALISE AT THE BOUNDARY ───────────────────────────────────────────────────────────────
  // Every figure arrives as a STRING from a text input, and an untouched cost/hours box arrives as
  // ''. `?? null` does not catch '', so it previously reached Prisma as a Decimal value and threw
  // inside the transaction — a bare 500 with no message, and the split silently never saved.
  // Normalising here means nothing downstream has to know the wire shape.
  const kids: SplitChildInput[] = (children ?? [])
    .filter((c) => c && c.description?.trim())
    .map((c) => ({
      description: String(c.description).trim(),
      qty: numOrNull(c.qty) ?? 0,
      amount: numOrNull(c.amount) ?? undefined,
      unitPrice: numOrNull(c.unitPrice) ?? undefined,
      kind: c.kind ?? null,
      catalogueItemId: c.catalogueItemId || null,
      partsCost: numOrNull(c.partsCost),
      labourHours: numOrNull(c.labourHours),
    }));

  // ── NO SILENT OVERWRITE ─────────────────────────────────────────────────────────────────────
  // The editor's fresh seed (whole parent + £0.00 labour) BALANCES, so it was saveable — and the
  // save deleted a real split and reported success. Replacing an existing split must therefore be
  // asked for explicitly, and the caller must prove it was looking at the split it means to replace.
  if (existing.length && !replace) {
    return res.status(409).json({
      message: 'This line is already split. Reload it and choose Replace split if you mean to change it.',
      existing: shapeOf(existing),
    });
  }
  // STALENESS: the client states which children it believes exist. Omitted means "none" — so a
  // caller unaware of the concept can never blunder over children it never saw.
  const seen = [...(expectedChildIds ?? [])].sort().join(',');
  const actual = existing.map((k: ExistingChild) => k.id).sort().join(',');
  if (seen !== actual) {
    return res.status(409).json({
      message: existing.length
        ? 'This split changed since you opened it. Reload before saving — the version on screen is out of date.'
        : 'This split changed since you opened it (its children are gone). Reload before saving.',
      existing: shapeOf(existing),
    });
  }

  // ── VALIDATE ────────────────────────────────────────────────────────────────────────────────
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
          // The AMOUNT is what was entered and what the invariant is on; the unit price is derived
          // from it through the chokepoint, so the stored pair can never disagree.
          unit_price: childUnitPrice(c) as any,
          amount: (childAmountPennies(c) / 100) as any,
          kind: (c.kind ?? null) as any,
          catalogue_item_id: c.catalogueItemId ?? null,
          parts_cost: c.partsCost as any,
          labour_hours: c.labourHours as any,
          cost_basis: c.partsCost != null || c.labourHours != null ? 'actual' : null,
          is_adjustment: false,
        })),
      });
      n++;
    }

    await writeImportAudit(tx, {
      groupId: vis.groupId as string, actorUserId: vis.userId, batchId: parent.staged_invoice.batch_id,
      action: existing.length ? 'import.split_replaced' : 'import.split_created',
      diff: {
        external_ref: parent.staged_invoice.external_number,
        line: parent.description,
        parentAmount: Number(parent.amount),
        children: kids.map((c) => ({
          description: c.description, qty: c.qty, amount: childAmountPennies(c) / 100,
          kind: c.kind ?? null, partsCost: c.partsCost, labourHours: c.labourHours,
        })),
        ...(existing.length ? { previous: shapeOf(existing) } : {}),
        appliedTo: n,
      },
    });
    return n;
  });

  return res.status(200).json({
    message: `Split saved and applied to ${applied} line${applied === 1 ? '' : 's'} across the batch.`,
    applied,
    balance: bal,
  });
}
