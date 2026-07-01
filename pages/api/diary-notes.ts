/**
 * File: pages/api/diary-notes.ts
 * Lightweight labelled diary entries (NOT job cards). A note is lift-specific (resourceId set) or
 * day-level (resourceId null). Gated to canManageSite (diary management). Notes do NOT participate
 * in the job double-booking guard — they're annotations that can coexist with a job on a lift.
 *   POST   { siteId, title, startAt, endAt, resourceId?, colour? } → create
 *   PATCH  { id, ...fields }                                       → edit
 *   DELETE { id }                                                  → remove
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { prisma } from '@/lib/db';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/pages/api/auth/[...nextauth]';
import { getVisibility } from '@/lib/site-visibility';
import { getTenantPermissions, canCreateDiaryEntry } from '@/lib/permissions';
import { isValidPaletteColour } from '@/lib/diary-colours';

function parseDate(s: unknown): Date | null {
  if (typeof s !== 'string' || !s) return null;
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const session = await getServerSession(req, res, authOptions);
  const user = session?.user as any;
  if (!user?.id || !user?.group_id) return res.status(401).json({ message: 'Not authenticated.' });
  const vis = await getVisibility(user.id as string);
  const perms = await getTenantPermissions(user.group_id as string);

  async function resolveNoteSite(noteId: string): Promise<string | null> {
    const n = await prisma.diaryNote.findFirst({ where: { id: noteId, group_id: user.group_id }, select: { site_id: true } });
    return n?.site_id ?? null;
  }
  // A resource (if given) must belong to the target site.
  async function validResource(resourceId: string | null | undefined, siteId: string): Promise<boolean> {
    if (!resourceId) return true;
    const r = await prisma.resource.findFirst({ where: { id: resourceId, site_id: siteId }, select: { id: true } });
    return !!r;
  }

  if (req.method === 'POST') {
    const { siteId, title, startAt, endAt, resourceId, colour } = (req.body || {}) as any;
    if (!siteId || !title || !`${title}`.trim()) return res.status(400).json({ message: 'A title and location are required.' });
    const site = await prisma.site.findFirst({ where: { id: siteId, group_id: user.group_id }, select: { id: true } });
    if (!site) return res.status(404).json({ message: 'Location not found.' });
    if (!canCreateDiaryEntry(vis, siteId, perms)) return res.status(403).json({ message: 'You do not have permission to add a diary note.' });
    const start = parseDate(startAt), end = parseDate(endAt);
    if (!start || !end || start >= end) return res.status(400).json({ message: 'Invalid start/end time.' });
    if (colour && !isValidPaletteColour(colour)) return res.status(400).json({ message: 'Invalid colour.' });
    if (!(await validResource(resourceId, siteId))) return res.status(400).json({ message: 'That lift is not at this location.' });

    const note = await prisma.diaryNote.create({
      data: { group_id: user.group_id, site_id: siteId, resource_id: resourceId || null, title: `${title}`.trim(), start_at: start, end_at: end, colour: colour || null, created_by: user.id },
      select: { id: true },
    });
    return res.status(201).json({ id: note.id, message: 'Note added.' });
  }

  if (req.method === 'PATCH') {
    const { id, title, startAt, endAt, resourceId, colour } = (req.body || {}) as any;
    if (!id) return res.status(400).json({ message: 'Missing id.' });
    const siteId = await resolveNoteSite(id);
    if (!siteId) return res.status(404).json({ message: 'Note not found.' });
    if (!canCreateDiaryEntry(vis, siteId, perms)) return res.status(403).json({ message: 'You do not have permission to edit a diary note.' });

    const data: any = {};
    if (title !== undefined) { if (!`${title}`.trim()) return res.status(400).json({ message: 'Title cannot be empty.' }); data.title = `${title}`.trim(); }
    if (startAt !== undefined || endAt !== undefined) {
      const start = parseDate(startAt), end = parseDate(endAt);
      if (!start || !end || start >= end) return res.status(400).json({ message: 'Invalid start/end time.' });
      data.start_at = start; data.end_at = end;
    }
    if (colour !== undefined) { if (colour && !isValidPaletteColour(colour)) return res.status(400).json({ message: 'Invalid colour.' }); data.colour = colour || null; }
    if (resourceId !== undefined) {
      if (!(await validResource(resourceId, siteId))) return res.status(400).json({ message: 'That lift is not at this location.' });
      data.resource_id = resourceId || null;
    }
    if (Object.keys(data).length === 0) return res.status(400).json({ message: 'Nothing to update.' });
    await prisma.diaryNote.update({ where: { id }, data });
    return res.status(200).json({ message: 'Note updated.' });
  }

  if (req.method === 'DELETE') {
    const id = (req.query.id as string) || (req.body && (req.body.id as string));
    if (!id) return res.status(400).json({ message: 'Missing id.' });
    const siteId = await resolveNoteSite(id);
    if (!siteId) return res.status(404).json({ message: 'Note not found.' });
    if (!canCreateDiaryEntry(vis, siteId, perms)) return res.status(403).json({ message: 'You do not have permission to remove a diary note.' });
    await prisma.diaryNote.delete({ where: { id } });
    return res.status(200).json({ message: 'Note removed.' });
  }

  res.setHeader('Allow', 'POST, PATCH, DELETE');
  return res.status(405).json({ message: 'Method Not Allowed' });
}
