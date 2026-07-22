/**
 * File: pages/api/superadmin/nav.ts
 * Navigation management — Owner + Country Manager (Support → 404, undiscoverable), region-scoped by
 * country_code like documents. Defines the marketing footer + main-nav links (ordered) that SiteChrome
 * renders from. Every mutation audited.
 *   GET                                        → list links in scope, ordered
 *   POST  { placement,label,kind,target,country,sort_order? } → create
 *   PATCH { id, label?,target?,kind?,enabled?,sort_order? }   → update / reorder
 *   DELETE { id }                              → remove
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import { requireOperatorApi } from '@/lib/operator-auth';
import { NAV_PLACEMENTS, NAV_KINDS } from '@/lib/nav';

function audit(actorId: string, action: string, label: string, detail: any) {
  return prisma.superAdminAudit.create({ data: {
    operator_user_id: actorId, action, target_group_id: null, target_operator_id: null,
    target_name_snapshot: label, detail: detail ?? Prisma.JsonNull,
  } }).catch(() => {});
}
const inScope = (actor: { role: string; regions?: string[] }, country: string) =>
  actor.role === 'owner' || (actor.regions ?? []).includes(country);

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  res.setHeader('Cache-Control', 'no-store');
  const actor = await requireOperatorApi(req, res);
  if (!actor) return;
  if (actor.role !== 'owner' && actor.role !== 'country_manager') { res.status(404).json({ message: 'Not found.' }); return; }
  const regionWhere = actor.role === 'owner' ? {} : { country_code: { in: (actor as any).regions?.length ? (actor as any).regions : ['__none__'] } };

  if (req.method === 'GET') {
    const links = await prisma.navLink.findMany({ where: regionWhere, orderBy: [{ placement: 'asc' }, { sort_order: 'asc' }] });
    return res.status(200).json({ links });
  }

  if (req.method === 'POST') {
    const b = (req.body || {}) as any;
    const placement = String(b.placement ?? '');
    const label = String(b.label ?? '').trim();
    const kind = String(b.kind ?? '');
    const target = String(b.target ?? '').trim();
    const country = String(b.country ?? 'GB').trim().toUpperCase().slice(0, 2) || 'GB';
    if (!NAV_PLACEMENTS.includes(placement as any)) return res.status(400).json({ message: 'Placement must be footer or main.' });
    if (!NAV_KINDS.includes(kind as any)) return res.status(400).json({ message: 'Kind must be document, route or external.' });
    if (!label || !target) return res.status(400).json({ message: 'Label and target are required.' });
    if (!inScope(actor as any, country)) return res.status(403).json({ message: 'Out of your region.' });
    const max = await prisma.navLink.aggregate({ where: { placement, country_code: country }, _max: { sort_order: true } });
    const link = await prisma.navLink.create({ data: { placement, label, kind, target, country_code: country, sort_order: (max._max.sort_order ?? 0) + 10, created_by: actor.userId } });
    await audit(actor.userId, 'nav.created', `${placement}:${label}`, { kind, target, country });
    return res.status(200).json({ ok: true, id: link.id, message: 'Link added.' });
  }

  if (req.method === 'PATCH') {
    const b = (req.body || {}) as any;
    const link = await prisma.navLink.findUnique({ where: { id: String(b.id ?? '') } });
    if (!link) return res.status(404).json({ message: 'Link not found.' });
    if (!inScope(actor as any, link.country_code)) return res.status(403).json({ message: 'Out of your region.' });
    const data: any = {};
    if (typeof b.label === 'string') data.label = b.label.trim();
    if (typeof b.target === 'string') data.target = b.target.trim();
    if (NAV_KINDS.includes(b.kind)) data.kind = b.kind;
    if (typeof b.enabled === 'boolean') data.enabled = b.enabled;
    if (typeof b.sort_order === 'number') data.sort_order = b.sort_order;
    if (!Object.keys(data).length) return res.status(400).json({ message: 'Nothing to update.' });
    await prisma.navLink.update({ where: { id: link.id }, data });
    await audit(actor.userId, 'nav.updated', `${link.placement}:${data.label ?? link.label}`, data);
    return res.status(200).json({ ok: true, message: 'Link updated.' });
  }

  if (req.method === 'DELETE') {
    const link = await prisma.navLink.findUnique({ where: { id: String((req.body?.id ?? req.query.id) ?? '') } });
    if (!link) return res.status(404).json({ message: 'Link not found.' });
    if (!inScope(actor as any, link.country_code)) return res.status(403).json({ message: 'Out of your region.' });
    await prisma.navLink.delete({ where: { id: link.id } });
    await audit(actor.userId, 'nav.deleted', `${link.placement}:${link.label}`, {});
    return res.status(200).json({ ok: true, message: 'Link removed.' });
  }

  res.setHeader('Allow', 'GET, POST, PATCH, DELETE');
  return res.status(405).json({ message: 'Method Not Allowed' });
}
