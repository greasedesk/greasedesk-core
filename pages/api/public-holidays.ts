/**
 * File: pages/api/public-holidays.ts
 * Bank/public holiday list (the Roster's second tab). GET = any authenticated group member;
 * POST/PATCH/DELETE = ADMIN only. POST { action: 'seedEW' } seeds the transcribed England &
 * Wales 2026–27 list (lib/bank-holidays-ew) with site_id = null (all sites) — IDEMPOTENT:
 * existing (group, null-site, date) rows are skipped, never duplicated (checked manually
 * because Postgres unique indexes treat NULL site_id as distinct — ON CONFLICT can't guard it).
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { prisma } from '@/lib/db';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/pages/api/auth/[...nextauth]';
import { getVisibility } from '@/lib/site-visibility';
import { EW_BANK_HOLIDAYS } from '@/lib/bank-holidays-ew';

const parseDay = (s: unknown): Date | null => {
  const ds = String(s || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(ds)) return null;
  const d = new Date(`${ds}T00:00:00.000Z`);
  return Number.isNaN(d.getTime()) ? null : d;
};

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const session = await getServerSession(req, res, authOptions);
  const user = session?.user as any;
  if (!user?.id || !user?.group_id) return res.status(401).json({ message: 'Not authenticated.' });
  const groupId = user.group_id as string;

  if (req.method === 'GET') {
    const rows = (await prisma.publicHoliday.findMany({
      where: { group_id: groupId }, orderBy: { date: 'asc' },
      select: { id: true, date: true, label: true, site_id: true },
    })) as any[];
    return res.status(200).json({ holidays: rows.map((r) => ({ id: r.id, date: r.date.toISOString().slice(0, 10), label: r.label, siteId: r.site_id })) });
  }

  const vis = await getVisibility(user.id as string);
  if (!vis.isAdmin) return res.status(403).json({ message: 'Only an admin can change the holiday list.' });

  if (req.method === 'POST') {
    const body = (req.body || {}) as any;
    if (body.action === 'seedEW') {
      let added = 0;
      for (const h of EW_BANK_HOLIDAYS) {
        const d = new Date(`${h.date}T00:00:00.000Z`);
        const exists = await prisma.publicHoliday.findFirst({ where: { group_id: groupId, site_id: null, date: d }, select: { id: true } });
        if (!exists) { await prisma.publicHoliday.create({ data: { group_id: groupId, site_id: null, date: d, label: h.label } }); added++; }
      }
      return res.status(200).json({ message: `Added ${added} bank holidays (${EW_BANK_HOLIDAYS.length - added} already present).`, added });
    }
    const d = parseDay(body.date);
    if (!d || !String(body.label || '').trim()) return res.status(400).json({ message: 'Enter a date and a name for the holiday.' });
    try {
      await prisma.publicHoliday.create({ data: { group_id: groupId, site_id: body.siteId || null, date: d, label: String(body.label).trim() } });
    } catch (e: any) {
      if (e?.code === 'P2002') return res.status(409).json({ message: 'There’s already a holiday on that date.' });
      throw e;
    }
    return res.status(200).json({ message: 'Holiday added.' });
  }

  if (req.method === 'PATCH') {
    const { id, date, label } = (req.body || {}) as any;
    if (!id) return res.status(400).json({ message: 'Missing holiday id.' });
    const row = await prisma.publicHoliday.findFirst({ where: { id, group_id: groupId }, select: { id: true } });
    if (!row) return res.status(404).json({ message: 'Holiday not found.' });
    const data: any = {};
    if (date !== undefined) { const d = parseDay(date); if (!d) return res.status(400).json({ message: 'Enter a valid date.' }); data.date = d; }
    if (label !== undefined) { if (!String(label).trim()) return res.status(400).json({ message: 'Enter a name.' }); data.label = String(label).trim(); }
    await prisma.publicHoliday.update({ where: { id }, data });
    return res.status(200).json({ message: 'Holiday updated.' });
  }

  if (req.method === 'DELETE') {
    const { id } = (req.body || {}) as any;
    if (!id) return res.status(400).json({ message: 'Missing holiday id.' });
    const row = await prisma.publicHoliday.findFirst({ where: { id, group_id: groupId }, select: { id: true } });
    if (!row) return res.status(404).json({ message: 'Holiday not found.' });
    await prisma.publicHoliday.delete({ where: { id } });
    return res.status(200).json({ message: 'Holiday removed.' });
  }

  res.setHeader('Allow', 'GET, POST, PATCH, DELETE');
  return res.status(405).json({ message: 'Method Not Allowed' });
}
