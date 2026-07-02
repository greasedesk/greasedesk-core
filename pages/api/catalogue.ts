/**
 * File: pages/api/catalogue.ts
 * Product catalogue CRUD. ADMIN/owner ONLY (requireAdminApi) — mechanics consume the autocomplete
 * but don't manage the catalogue. Tenant-scoped (one shared catalogue per Group). code is unique per
 * tenant (@@unique(group_id, code)). New items default their VAT rate from the company default
 * (lib/tenant-vat.ts). Archive (active=false) is preferred over delete; hard delete is SetNull-safe.
 *   GET                                             → { items[], defaultVatRate }
 *   POST   { code, name, itemType, unitCost, unitPrice, vatRate?, active? }
 *   PATCH  { id, code?, name?, itemType?, unitCost?, unitPrice?, vatRate?, active? }
 *   DELETE { id }  (query or body)                  → hard delete (line links SetNull)
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import { requireAdminApi } from '@/lib/admin-guard';
import { getTenantVat } from '@/lib/tenant-vat';

const TYPES = new Set(['labour', 'part', 'misc']);
const dec = (v: unknown): number | null => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const clampRate = (v: unknown): number => Math.min(100, Math.max(0, Number.isFinite(Number(v)) ? Number(v) : 0));

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const vis = await requireAdminApi(req, res); // 401/403 handled inside
  if (!vis) return;
  if (!vis.groupId) return res.status(400).json({ message: 'No tenant context.' });
  const groupId = vis.groupId;

  if (req.method === 'GET') {
    const vat = await getTenantVat(groupId);
    const items = (await prisma.catalogueItem.findMany({
      where: { group_id: groupId },
      orderBy: [{ active: 'desc' }, { code: 'asc' }],
      select: { id: true, code: true, name: true, item_type: true, unit_cost: true, unit_price: true, vat_rate: true, active: true },
    })) as any[];
    return res.status(200).json({
      defaultVatRate: vat.defaultRate,
      items: items.map((i) => ({
        id: i.id, code: i.code, name: i.name, itemType: i.item_type,
        unitCost: Number(i.unit_cost), unitPrice: Number(i.unit_price), vatRate: Number(i.vat_rate), active: i.active,
      })),
    });
  }

  if (req.method === 'POST' || req.method === 'PATCH') {
    const body = (req.body || {}) as any;
    const isPatch = req.method === 'PATCH';
    const id = typeof body.id === 'string' ? body.id : '';
    if (isPatch && !id) return res.status(400).json({ message: 'Missing id.' });

    // Build the data set (all fields optional on PATCH; required on POST).
    const data: any = {};
    if (body.code !== undefined || !isPatch) {
      const code = String(body.code ?? '').trim();
      if (!code) return res.status(400).json({ message: 'Code is required.' });
      data.code = code;
    }
    if (body.name !== undefined || !isPatch) {
      const name = String(body.name ?? '').trim();
      if (!name) return res.status(400).json({ message: 'Name is required.' });
      data.name = name;
    }
    if (body.itemType !== undefined || !isPatch) {
      const t = String(body.itemType ?? '');
      if (!TYPES.has(t)) return res.status(400).json({ message: 'Type must be labour, part or misc.' });
      data.item_type = t;
    }
    if (body.unitCost !== undefined || !isPatch) {
      const c = dec(body.unitCost);
      if (c === null || c < 0) return res.status(400).json({ message: 'Cost must be a non-negative number.' });
      data.unit_cost = new Prisma.Decimal(c.toFixed(2));
    }
    if (body.unitPrice !== undefined || !isPatch) {
      const pr = dec(body.unitPrice);
      if (pr === null) return res.status(400).json({ message: 'Price must be a number.' });
      data.unit_price = new Prisma.Decimal(pr.toFixed(2));
    }
    if (body.vatRate !== undefined) data.vat_rate = new Prisma.Decimal(clampRate(body.vatRate).toFixed(2));
    else if (!isPatch) {
      const vat = await getTenantVat(groupId);
      data.vat_rate = new Prisma.Decimal(clampRate(vat.defaultRate).toFixed(2));
    }
    if (body.active !== undefined) data.active = !!body.active;

    try {
      if (isPatch) {
        const owned = await prisma.catalogueItem.findFirst({ where: { id, group_id: groupId }, select: { id: true } });
        if (!owned) return res.status(404).json({ message: 'Item not found.' });
        await prisma.catalogueItem.update({ where: { id }, data });
        return res.status(200).json({ message: 'Item updated.' });
      }
      const created = await prisma.catalogueItem.create({ data: { group_id: groupId, ...data }, select: { id: true } });
      return res.status(201).json({ id: created.id, message: 'Item added.' });
    } catch (e: any) {
      if (e?.code === 'P2002') return res.status(409).json({ message: 'That code is already in use.' });
      console.error('Catalogue write error:', e);
      return res.status(500).json({ message: 'Could not save the item.' });
    }
  }

  if (req.method === 'DELETE') {
    const id = typeof req.query.id === 'string' ? req.query.id : (req.body?.id as string) || '';
    if (!id) return res.status(400).json({ message: 'Missing id.' });
    const del = await prisma.catalogueItem.deleteMany({ where: { id, group_id: groupId } }); // line links SetNull
    if (del.count === 0) return res.status(404).json({ message: 'Item not found.' });
    return res.status(200).json({ message: 'Item deleted.' });
  }

  res.setHeader('Allow', 'GET, POST, PATCH, DELETE');
  return res.status(405).json({ message: 'Method Not Allowed' });
}
