/**
 * File: pages/api/catalogue.ts
 * Product catalogue CRUD. ADMIN/owner ONLY (requireAdminApi); tenant-scoped; code unique per tenant.
 * Simple items (part/labour/misc): flat cost + price. Fixed services: base_price_ex_vat + a component
 * list (cost + spec text) + optional per-tier price overrides. The legacy unit_price/unit_cost are
 * MIRRORED for fixed items via lib/catalogue.ts (fixedMirror) INSIDE this write path on every write —
 * never a caller responsibility, so it can't drift. Archive over delete; hard delete SetNull-safe.
 *   GET  → { items[], tiers[], defaultVatRate, vatRegistered }
 *   POST/PATCH simple: { code,name,itemType,unitCost,unitPrice,vatRate?,active? }
 *   POST/PATCH fixed:  { code,name,itemType:'fixed',basePriceExVat,components[],tierPrices[],vatRate?,active? }
 *   DELETE { id }
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import { requireAdminApi } from '@/lib/admin-guard';
import { getTenantVat } from '@/lib/tenant-vat';
import { fixedMirror, ComponentInput } from '@/lib/catalogue';

const TYPES = new Set(['labour', 'part', 'misc', 'fixed']);
const dec = (v: unknown): number | null => { const n = Number(v); return Number.isFinite(n) ? n : null; };
const clampRate = (v: unknown): number => Math.min(100, Math.max(0, Number.isFinite(Number(v)) ? Number(v) : 0));

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const vis = await requireAdminApi(req, res);
  if (!vis) return;
  if (!vis.groupId) return res.status(400).json({ message: 'No tenant context.' });
  const groupId = vis.groupId;

  if (req.method === 'GET') {
    const vat = await getTenantVat(groupId);
    const [items, tiers] = await Promise.all([
      prisma.catalogueItem.findMany({
        where: { group_id: groupId },
        orderBy: [{ active: 'desc' }, { code: 'asc' }],
        select: {
          id: true, code: true, title: true, name: true, item_type: true, unit_cost: true, unit_price: true, vat_rate: true, active: true,
          base_price_ex_vat: true,
          components: { orderBy: { position: 'asc' }, select: { description: true, qty: true, unit_cost_ex_vat: true } },
          tier_prices: { select: { tier_id: true, price_ex_vat: true } },
        },
      }) as Promise<any[]>,
      prisma.serviceTier.findMany({ where: { group_id: groupId }, orderBy: [{ position: 'asc' }, { created_at: 'asc' }], select: { id: true, name: true, position: true, active: true } }) as Promise<any[]>,
    ]);
    return res.status(200).json({
      defaultVatRate: vat.defaultRate,
      vatRegistered: vat.registered,
      tiers: tiers.map((t) => ({ id: t.id, name: t.name, position: t.position, active: t.active })),
      items: items.map((i) => ({
        id: i.id, code: i.code, title: i.title, name: i.name, itemType: i.item_type,
        unitCost: Number(i.unit_cost), unitPrice: Number(i.unit_price), vatRate: Number(i.vat_rate), active: i.active,
        basePriceExVat: i.base_price_ex_vat == null ? null : Number(i.base_price_ex_vat),
        components: i.components.map((c: any) => ({ description: c.description, qty: Number(c.qty), unitCostExVat: Number(c.unit_cost_ex_vat) })),
        tierPrices: i.tier_prices.map((tp: any) => ({ tierId: tp.tier_id, priceExVat: tp.price_ex_vat == null ? null : Number(tp.price_ex_vat) })),
      })),
    });
  }

  if (req.method === 'POST' || req.method === 'PATCH') {
    const body = (req.body || {}) as any;
    const isPatch = req.method === 'PATCH';
    const id = typeof body.id === 'string' ? body.id : '';
    if (isPatch && !id) return res.status(400).json({ message: 'Missing id.' });

    // Resolve the effective type (needed to branch simple vs fixed). On PATCH without itemType, read existing.
    let itemType = body.itemType !== undefined ? String(body.itemType) : '';
    if (isPatch && !itemType) {
      const existing = (await prisma.catalogueItem.findFirst({ where: { id, group_id: groupId }, select: { item_type: true } })) as { item_type: string } | null;
      if (!existing) return res.status(404).json({ message: 'Item not found.' });
      itemType = existing.item_type;
    }
    if ((body.itemType !== undefined || !isPatch) && !TYPES.has(itemType)) {
      return res.status(400).json({ message: 'Type must be labour, part, misc or fixed.' });
    }
    const isFixed = itemType === 'fixed';

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
    // Human label (optional). Empty → null so consumers fall back to code.
    if (body.title !== undefined) data.title = String(body.title ?? '').trim() || null;
    if (body.itemType !== undefined || !isPatch) data.item_type = itemType as any;
    if (body.vatRate !== undefined) data.vat_rate = new Prisma.Decimal(clampRate(body.vatRate).toFixed(2));
    else if (!isPatch) { const vat = await getTenantVat(groupId); data.vat_rate = new Prisma.Decimal(clampRate(vat.defaultRate).toFixed(2)); }
    if (body.active !== undefined) data.active = !!body.active;

    // --- Fixed vs simple money handling ---
    let components: ComponentInput[] = [];
    let tierRows: Array<{ tier_id: string; price_ex_vat: Prisma.Decimal | null }> = [];

    if (isFixed) {
      // base_price required (on POST, or when editing a fixed item's price).
      const baseProvided = body.basePriceExVat !== undefined && body.basePriceExVat !== null && body.basePriceExVat !== '';
      let base: number | null = null;
      if (baseProvided) {
        base = dec(body.basePriceExVat);
        if (base === null || base < 0) return res.status(400).json({ message: 'Base price (ex VAT) must be a non-negative number.' });
      } else if (!isPatch) {
        return res.status(400).json({ message: 'Base price (ex VAT) is required for a fixed-price service.' });
      }

      // Components (replace-all when provided; required to derive cost).
      if (Array.isArray(body.components)) {
        for (const c of body.components) {
          const description = String(c?.description ?? '').trim();
          if (!description) return res.status(400).json({ message: 'Each component needs a description.' });
          const qty = dec(c?.qty); const cost = dec(c?.unitCostExVat);
          if (qty === null || qty < 0) return res.status(400).json({ message: 'Component qty must be a non-negative number.' });
          if (cost === null || cost < 0) return res.status(400).json({ message: 'Component cost must be a non-negative number.' });
          components.push({ description, qty, unitCostExVat: cost });
        }
      }

      // Tier price rows (only tiers the tenant owns; price null = manual/price-on-the-day).
      if (Array.isArray(body.tierPrices)) {
        const validTiers = new Set(((await prisma.serviceTier.findMany({ where: { group_id: groupId }, select: { id: true } })) as Array<{ id: string }>).map((t) => t.id));
        for (const tp of body.tierPrices) {
          const tierId = String(tp?.tierId ?? '');
          if (!validTiers.has(tierId)) continue;
          const hasPrice = tp?.priceExVat !== undefined && tp?.priceExVat !== null && tp?.priceExVat !== '';
          if (hasPrice) {
            const pr = dec(tp.priceExVat);
            if (pr === null || pr < 0) return res.status(400).json({ message: 'Tier price (ex VAT) must be a non-negative number.' });
            tierRows.push({ tier_id: tierId, price_ex_vat: new Prisma.Decimal(pr.toFixed(2)) });
          } else {
            tierRows.push({ tier_id: tierId, price_ex_vat: null }); // offered, price-on-the-day
          }
        }
      }

      // MIRROR (chokepoint): unit_price = base, unit_cost = Σ components — derived here, every write.
      // On PATCH without a new base, read the existing base so the mirror stays consistent.
      let effectiveBase = base;
      if (effectiveBase === null && isPatch) {
        const ex = (await prisma.catalogueItem.findFirst({ where: { id, group_id: groupId }, select: { base_price_ex_vat: true } })) as { base_price_ex_vat: unknown } | null;
        effectiveBase = ex?.base_price_ex_vat != null ? Number(ex.base_price_ex_vat) : 0;
      }
      const mirror = fixedMirror(effectiveBase ?? 0, components);
      if (base !== null) data.base_price_ex_vat = new Prisma.Decimal(base.toFixed(2));
      data.unit_price = new Prisma.Decimal(mirror.unitPricePounds.toFixed(2));
      data.unit_cost = new Prisma.Decimal(mirror.unitCostPounds.toFixed(2));
    } else {
      // Simple items: flat cost + price; clear any fixed-only data.
      if (body.unitCost !== undefined && body.unitCost !== null && body.unitCost !== '') {
        const c = dec(body.unitCost);
        if (c === null || c < 0) return res.status(400).json({ message: 'Cost must be a non-negative number.' });
        data.unit_cost = new Prisma.Decimal(c.toFixed(2));
      } else if (!isPatch) return res.status(400).json({ message: 'Cost is required.' });
      if (body.unitPrice !== undefined || !isPatch) {
        const pr = dec(body.unitPrice);
        if (pr === null) return res.status(400).json({ message: 'Price must be a number.' });
        data.unit_price = new Prisma.Decimal(pr.toFixed(2));
      }
      data.base_price_ex_vat = null;
    }

    try {
      const savedId = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
        let itemId = id;
        if (isPatch) {
          const owned = await tx.catalogueItem.findFirst({ where: { id, group_id: groupId }, select: { id: true } });
          if (!owned) throw new Error('NOT_FOUND');
          await tx.catalogueItem.update({ where: { id }, data });
        } else {
          const created = await tx.catalogueItem.create({ data: { group_id: groupId, ...data }, select: { id: true } });
          itemId = created.id;
        }
        // Fixed → replace components + tier prices; simple → ensure none linger.
        if (isFixed) {
          if (Array.isArray(body.components)) {
            await tx.catalogueComponent.deleteMany({ where: { catalogue_item_id: itemId } });
            if (components.length) await tx.catalogueComponent.createMany({ data: components.map((c, i) => ({ catalogue_item_id: itemId, description: c.description, qty: new Prisma.Decimal(c.qty.toFixed(2)), unit_cost_ex_vat: new Prisma.Decimal(c.unitCostExVat.toFixed(2)), position: i })) });
          }
          if (Array.isArray(body.tierPrices)) {
            await tx.catalogueItemTierPrice.deleteMany({ where: { catalogue_item_id: itemId } });
            if (tierRows.length) await tx.catalogueItemTierPrice.createMany({ data: tierRows.map((r) => ({ catalogue_item_id: itemId, tier_id: r.tier_id, price_ex_vat: r.price_ex_vat })) });
          }
        } else {
          await tx.catalogueComponent.deleteMany({ where: { catalogue_item_id: itemId } });
          await tx.catalogueItemTierPrice.deleteMany({ where: { catalogue_item_id: itemId } });
        }
        return itemId;
      });
      return res.status(isPatch ? 200 : 201).json({ id: savedId, message: isPatch ? 'Item updated.' : 'Item added.' });
    } catch (e: any) {
      if (e?.message === 'NOT_FOUND') return res.status(404).json({ message: 'Item not found.' });
      if (e?.code === 'P2002') return res.status(409).json({ message: 'That code is already in use.' });
      console.error('Catalogue write error:', e);
      return res.status(500).json({ message: 'Could not save the item.' });
    }
  }

  if (req.method === 'DELETE') {
    const id = typeof req.query.id === 'string' ? req.query.id : (req.body?.id as string) || '';
    if (!id) return res.status(400).json({ message: 'Missing id.' });
    const del = await prisma.catalogueItem.deleteMany({ where: { id, group_id: groupId } }); // components/tiers cascade; line links SetNull
    if (del.count === 0) return res.status(404).json({ message: 'Item not found.' });
    return res.status(200).json({ message: 'Item deleted.' });
  }

  res.setHeader('Allow', 'GET, POST, PATCH, DELETE');
  return res.status(405).json({ message: 'Method Not Allowed' });
}
