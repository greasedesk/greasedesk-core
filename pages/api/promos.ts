/**
 * File: pages/api/promos.ts
 * Promotions CRUD — reusable VAT-aware discount codes. ADMIN-only, tenant-scoped. A promo is NOT a
 * product (not sellable); it's applied on an estimate as a negative discount line (see lib/promo.ts).
 *   GET                                                → { promos[], defaultVatRate, vatRegistered }
 *   POST   { code, label, type, amount }
 *   PATCH  { id, code?, label?, type?, amount?, active? }
 *   DELETE { id }
 * `amount` is INC-VAT £ for a fixed promo, or the percentage for a percentage promo.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { Prisma, PromoType } from '@prisma/client';
import { prisma } from '@/lib/db';
import { requireAdminApi } from '@/lib/admin-guard';
import { getTenantVat } from '@/lib/tenant-vat';

const TYPES: PromoType[] = ['fixed', 'percentage'];

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const vis = await requireAdminApi(req, res);
  if (!vis) return;
  if (!vis.groupId) return res.status(400).json({ message: 'No tenant context.' });
  const groupId = vis.groupId;

  if (req.method === 'GET') {
    const [promoRows, vat] = await Promise.all([
      prisma.promo.findMany({ where: { group_id: groupId }, orderBy: [{ active: 'desc' }, { code: 'asc' }], select: { id: true, code: true, label: true, promo_type: true, amount: true, active: true, targets: { select: { item: { select: { id: true, title: true, name: true } } } } } }) as Promise<any[]>,
      getTenantVat(groupId),
    ]);
    return res.status(200).json({
      promos: promoRows.map((p) => ({ id: p.id, code: p.code, label: p.label, type: p.promo_type, amount: Number(p.amount), active: p.active, targets: p.targets.map((t: any) => ({ id: t.item.id, title: t.item.title || t.item.name })) })),
      defaultVatRate: vat.defaultRate, vatRegistered: vat.registered,
    });
  }

  if (req.method === 'POST' || req.method === 'PATCH') {
    const body = (req.body || {}) as any;
    const isPatch = req.method === 'PATCH';
    const id = typeof body.id === 'string' ? body.id : '';
    if (isPatch && !id) return res.status(400).json({ message: 'Missing id.' });

    const data: Prisma.PromoUncheckedUpdateInput = {};
    if (body.code !== undefined || !isPatch) {
      const code = String(body.code ?? '').trim();
      if (!code) return res.status(400).json({ message: 'A promo code is required.' });
      data.code = code;
    }
    if (body.label !== undefined || !isPatch) {
      const label = String(body.label ?? '').trim();
      if (!label) return res.status(400).json({ message: 'A label is required.' });
      data.label = label;
    }
    if (body.type !== undefined || !isPatch) {
      const type = String(body.type) as PromoType;
      if (!TYPES.includes(type)) return res.status(400).json({ message: 'Type must be fixed or percentage.' });
      data.promo_type = type;
    }
    if (body.amount !== undefined || !isPatch) {
      const amount = Number(body.amount);
      if (!Number.isFinite(amount) || amount < 0) return res.status(400).json({ message: 'Amount must be a positive number.' });
      // A percentage can't exceed 100.
      const effType = (data.promo_type as PromoType) ?? undefined;
      if (effType === 'percentage' && amount > 100) return res.status(400).json({ message: 'A percentage can’t exceed 100.' });
      data.amount = new Prisma.Decimal(amount.toFixed(2));
    }
    if (body.active !== undefined) data.active = !!body.active;

    // Targets (percentage only). Validate ids belong to THIS tenant's catalogue; a fixed promo clears
    // them. `undefined` (field omitted on a PATCH) = leave targets untouched.
    const effType = (data.promo_type as PromoType) ?? undefined;
    let targetIds: string[] | undefined;
    if (body.targetProductIds !== undefined || (!isPatch)) {
      const raw = Array.isArray(body.targetProductIds) ? body.targetProductIds.filter((x: any) => typeof x === 'string') : [];
      if (effType === 'fixed') targetIds = [];
      else if (raw.length) {
        const owned = (await prisma.catalogueItem.findMany({ where: { id: { in: raw }, group_id: groupId }, select: { id: true } })) as Array<{ id: string }>;
        targetIds = owned.map((o) => o.id);
      } else targetIds = [];
    }

    try {
      const result = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
        let promoId = id;
        if (isPatch) {
          const owned = await tx.promo.findFirst({ where: { id, group_id: groupId }, select: { id: true } });
          if (!owned) return { notFound: true };
          await tx.promo.update({ where: { id }, data });
        } else {
          const created = await tx.promo.create({ data: { ...(data as any), group_id: groupId } as Prisma.PromoUncheckedCreateInput, select: { id: true } });
          promoId = created.id;
        }
        if (targetIds !== undefined) {
          await tx.promoTarget.deleteMany({ where: { promo_id: promoId } });
          if (targetIds.length) await tx.promoTarget.createMany({ data: targetIds.map((cid) => ({ promo_id: promoId, catalogue_item_id: cid })) });
        }
        return { id: promoId };
      });
      if ((result as any).notFound) return res.status(404).json({ message: 'Promo not found.' });
      return res.status(isPatch ? 200 : 201).json({ id: (result as any).id, message: isPatch ? 'Promo updated.' : 'Promo added.' });
    } catch (e: any) {
      if (e?.code === 'P2002') return res.status(409).json({ message: 'That promo code is already in use.' });
      console.error('Promo write error:', e);
      return res.status(500).json({ message: 'Could not save the promo.' });
    }
  }

  if (req.method === 'DELETE') {
    const id = typeof req.query.id === 'string' ? req.query.id : (req.body?.id as string) || '';
    if (!id) return res.status(400).json({ message: 'Missing id.' });
    const del = await prisma.promo.deleteMany({ where: { id, group_id: groupId } });
    if (del.count === 0) return res.status(404).json({ message: 'Promo not found.' });
    return res.status(200).json({ message: 'Promo deleted.' });
  }

  res.setHeader('Allow', 'GET, POST, PATCH, DELETE');
  return res.status(405).json({ message: 'Method Not Allowed' });
}
