/**
 * File: pages/api/superadmin/content.ts
 * THE Content write surface. Owner + Country Manager reach it (Support → 404, undiscoverable); `legal`
 * actions are Owner-only, server-enforced. Region-scoped by country_code for a CM. Every mutation
 * audited. The freeze discipline lives HERE: a PUBLISHED row is immutable — you never edit or delete it,
 * you publish a NEW version (a fresh draft → publish). That rule is enforced for BOTH types; the type
 * difference is only at publish time (legal requires an effective date; page publishes immediately).
 *
 *   GET                              → list (per slug+country: title,type,published version+date,hasDraft)
 *   GET ?slug=&country=              → one doc: { draft, published[] } (editor + history)
 *   POST { action:'create', slug,title,type,country,body }      → first draft
 *   POST { action:'new_version', slug,country }                 → a draft pre-filled from latest published
 *   PATCH { id, title?, body? }      → save the DRAFT (refused on a published row)
 *   POST { action:'publish', id, effectiveFrom? }               → publish the draft (legal needs the date)
 *   DELETE { id }                    → discard a DRAFT (published is never deletable)
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import { requireOperatorApi } from '@/lib/operator-auth';
import { DRAFT, canEditType, isDocType, sanitiseSlug, nextVersionStamp, resolvePublished } from '@/lib/content';

function audit(actorId: string, action: string, slug: string, country: string, detail: any) {
  return prisma.superAdminAudit.create({ data: {
    operator_user_id: actorId, action, target_group_id: null, target_operator_id: null,
    target_name_snapshot: `${slug}/${country}`, detail: detail ?? Prisma.JsonNull,
  } }).catch(() => {});
}
/** CM may only touch their own regions; Owner is unbound. */
const inScope = (actor: { role: string; regions?: string[] }, country: string) =>
  actor.role === 'owner' || (actor.regions ?? []).includes(country);

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  res.setHeader('Cache-Control', 'no-store');
  const actor = await requireOperatorApi(req, res); // any operator; wrong class → 404
  if (!actor) return;
  if (actor.role !== 'owner' && actor.role !== 'country_manager') { res.status(404).json({ message: 'Not found.' }); return; } // Support: undiscoverable
  const regionWhere = actor.role === 'owner' ? {} : { country_code: { in: (actor as any).regions?.length ? (actor as any).regions : ['__none__'] } };

  // ── READ ─────────────────────────────────────────────────────────────────────────────────────
  if (req.method === 'GET') {
    const slug = typeof req.query.slug === 'string' ? req.query.slug : null;
    const country = typeof req.query.country === 'string' ? req.query.country : null;
    if (slug && country) {
      if (!inScope(actor as any, country)) return res.status(404).json({ message: 'Not found.' });
      const rows = await prisma.document.findMany({ where: { slug, country_code: country }, orderBy: { created_at: 'asc' } });
      const draft = rows.find((r: any) => r.status === 'draft') ?? null;
      const published = rows.filter((r: any) => r.status === 'published').sort((a: any, b: any) => (b.published_at?.getTime() ?? 0) - (a.published_at?.getTime() ?? 0));
      return res.status(200).json({ draft, published });
    }
    const all = await prisma.document.findMany({ where: regionWhere, orderBy: [{ slug: 'asc' }, { country_code: 'asc' }] });
    const keys = new Map<string, any>();
    for (const r of all as any[]) {
      const k = `${r.slug}/${r.country_code}`;
      const e = keys.get(k) ?? { slug: r.slug, country: r.country_code, type: r.type, title: r.title, publishedVersion: null as string | null, effectiveFrom: null as string | null, publishedAt: null as string | null, hasDraft: false };
      if (r.status === 'draft') { e.hasDraft = true; e.title = r.title; e.type = r.type; }
      else if (r.status === 'published' && (!e.publishedAt || (r.published_at && r.published_at.toISOString() > e.publishedAt))) {
        e.publishedVersion = r.version; e.effectiveFrom = r.effective_from ? r.effective_from.toISOString().slice(0, 10) : null; e.publishedAt = r.published_at?.toISOString() ?? null; e.title = r.title; e.type = r.type;
      }
      keys.set(k, e);
    }
    return res.status(200).json({ documents: [...keys.values()] });
  }

  // ── CREATE / NEW-VERSION / PUBLISH ─────────────────────────────────────────────────────────────
  if (req.method === 'POST') {
    const b = (req.body || {}) as any;

    if (b.action === 'create') {
      const slug = sanitiseSlug(b.slug); const title = String(b.title ?? '').trim();
      const type = b.type; const country = String(b.country ?? 'GB').trim().toUpperCase().slice(0, 2) || 'GB';
      const body = String(b.body ?? '');
      if (!slug || !title) return res.status(400).json({ message: 'Slug and title are required.' });
      if (!isDocType(type)) return res.status(400).json({ message: 'Type must be legal or page.' });
      if (!canEditType(actor.role, type) || !inScope(actor as any, country)) return res.status(403).json({ message: 'You cannot create this document.' });
      try {
        const doc = await prisma.document.create({ data: { slug, title, type, country_code: country, body, version: DRAFT, status: 'draft', created_by: actor.userId } });
        await audit(actor.userId, 'document.created', slug, country, { type });
        return res.status(200).json({ ok: true, id: doc.id, message: 'Draft created.' });
      } catch (e: any) {
        if (e?.code === 'P2002') return res.status(409).json({ message: 'A draft already exists for this document — publish or discard it first.' });
        throw e;
      }
    }

    if (b.action === 'new_version') {
      const slug = sanitiseSlug(b.slug); const country = String(b.country ?? 'GB').toUpperCase();
      const latest = await resolvePublished(prisma, slug, country);
      if (!latest || latest.country_code !== country) return res.status(404).json({ message: 'No published version to fork.' });
      if (!canEditType(actor.role, latest.type) || !inScope(actor as any, country)) return res.status(403).json({ message: 'You cannot edit this document.' });
      try {
        const doc = await prisma.document.create({ data: { slug, title: latest.title, type: latest.type, country_code: country, body: latest.body, version: DRAFT, status: 'draft', created_by: actor.userId } });
        return res.status(200).json({ ok: true, id: doc.id, message: 'New draft created from the current version.' });
      } catch (e: any) {
        if (e?.code === 'P2002') return res.status(409).json({ message: 'A draft already exists — publish or discard it first.' });
        throw e;
      }
    }

    if (b.action === 'publish') {
      const doc = await prisma.document.findUnique({ where: { id: String(b.id ?? '') } });
      if (!doc) return res.status(404).json({ message: 'Document not found.' });
      if (doc.status !== 'draft') return res.status(409).json({ code: 'immutable', message: 'That version is already published and is immutable. Create a new version instead.' });
      if (!canEditType(actor.role, doc.type as any) || !inScope(actor as any, doc.country_code)) return res.status(403).json({ message: 'You cannot publish this document.' });
      // legal REQUIRES an effective date and becomes immutable; page publishes immediately (defaults now).
      let effectiveFrom: Date;
      if (doc.type === 'legal') {
        if (!b.effectiveFrom || !/^\d{4}-\d{2}-\d{2}$/.test(String(b.effectiveFrom))) return res.status(400).json({ message: 'A legal document needs an effective date (YYYY-MM-DD) — the published version becomes immutable.' });
        effectiveFrom = new Date(String(b.effectiveFrom) + 'T00:00:00.000Z');
      } else {
        effectiveFrom = b.effectiveFrom && /^\d{4}-\d{2}-\d{2}$/.test(String(b.effectiveFrom)) ? new Date(String(b.effectiveFrom) + 'T00:00:00.000Z') : new Date();
      }
      const version = await nextVersionStamp(prisma, doc.slug, doc.country_code, effectiveFrom);
      await prisma.document.update({ where: { id: doc.id }, data: { version, status: 'published', published_at: new Date(), effective_from: effectiveFrom } });
      await audit(actor.userId, 'document.published', doc.slug, doc.country_code, { type: doc.type, version, effective_from: effectiveFrom.toISOString().slice(0, 10) });
      return res.status(200).json({ ok: true, version, message: `Published ${doc.type === 'legal' ? 'immutable ' : ''}version ${version}.` });
    }

    return res.status(400).json({ message: 'Unknown action.' });
  }

  // ── SAVE DRAFT (never a published row) ─────────────────────────────────────────────────────────
  if (req.method === 'PATCH') {
    const b = (req.body || {}) as any;
    const doc = await prisma.document.findUnique({ where: { id: String(b.id ?? '') } });
    if (!doc) return res.status(404).json({ message: 'Document not found.' });
    if (doc.status !== 'draft') return res.status(409).json({ code: 'immutable', message: 'A published version cannot be edited — it is frozen. Create a new version instead.' });
    if (!canEditType(actor.role, doc.type as any) || !inScope(actor as any, doc.country_code)) return res.status(403).json({ message: 'You cannot edit this document.' });
    const data: any = {};
    if (typeof b.title === 'string') data.title = b.title.trim();
    if (typeof b.body === 'string') data.body = b.body;
    if (!Object.keys(data).length) return res.status(400).json({ message: 'Nothing to save.' });
    await prisma.document.update({ where: { id: doc.id }, data });
    await audit(actor.userId, 'document.draft_saved', doc.slug, doc.country_code, { type: doc.type });
    return res.status(200).json({ ok: true, message: 'Draft saved.' });
  }

  // ── DISCARD DRAFT (published never deletable) ──────────────────────────────────────────────────
  if (req.method === 'DELETE') {
    const doc = await prisma.document.findUnique({ where: { id: String((req.body?.id ?? req.query.id) ?? '') } });
    if (!doc) return res.status(404).json({ message: 'Document not found.' });
    if (doc.status !== 'draft') return res.status(409).json({ code: 'immutable', message: 'A published version is immutable and cannot be deleted.' });
    if (!canEditType(actor.role, doc.type as any) || !inScope(actor as any, doc.country_code)) return res.status(403).json({ message: 'You cannot discard this document.' });
    await prisma.document.delete({ where: { id: doc.id } });
    return res.status(200).json({ ok: true, message: 'Draft discarded.' });
  }

  res.setHeader('Allow', 'GET, POST, PATCH, DELETE');
  return res.status(405).json({ message: 'Method Not Allowed' });
}
