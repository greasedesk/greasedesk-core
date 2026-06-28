/**
 * File: pages/api/resources.ts
 * Resources now belong to a Site (Location): operational tree Group → Site → Resource.
 * Scoped to the caller's group (a Site must belong to the caller's group_id).
 *
 *   POST   { site_id, name, type, display_order? }            → create
 *   PATCH  { id, name?, type?, display_order?, is_active? }    → update
 *   DELETE { id }                                             → delete
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { prisma } from '@/lib/db';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/pages/api/auth/[...nextauth]';
import { ResourceType } from '@prisma/client';
import { isValidPaletteColour, RESOURCE_PALETTE } from '@/lib/diary-colours';

const VALID_TYPES = Object.values(ResourceType) as string[];

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const session = await getServerSession(req, res, authOptions);
  const user = session?.user as any;
  if (!user?.group_id || !user?.site_id) {
    return res.status(401).json({ message: 'Authentication Error: Group/Site context not found.' });
  }
  const groupId = user.group_id as string;

  // A Site is in scope if it belongs to the caller's group.
  async function ownSite(siteId: string) {
    if (!siteId) return null;
    return prisma.site.findFirst({ where: { id: siteId, group_id: groupId }, select: { id: true } });
  }
  // A Resource is in scope if its Site belongs to the caller's group.
  async function ownResource(id: string) {
    if (!id) return null;
    return prisma.resource.findFirst({ where: { id, site: { group_id: groupId } }, select: { id: true } });
  }
  function parseOrder(v: unknown): number | null {
    if (v === undefined || v === null || `${v}`.trim() === '') return null;
    const n = Number(v);
    if (!Number.isFinite(n)) return null;
    return Math.trunc(n);
  }

  if (req.method === 'POST') {
    const { site_id, name, type, display_order } = (req.body || {}) as {
      site_id?: string; name?: string; type?: string; display_order?: number | string;
    };
    const cleanName = (name || '').trim();
    if (!site_id) return res.status(400).json({ message: 'Missing site_id.' });
    if (!cleanName) return res.status(400).json({ message: 'Name is required.' });
    if (!type || !VALID_TYPES.includes(type)) {
      return res.status(400).json({ message: `Type must be one of: ${VALID_TYPES.join(', ')}.` });
    }
    if (!(await ownSite(site_id))) return res.status(404).json({ message: 'Location not found.' });
    const order = parseOrder(display_order);
    // Auto-assign the FIRST UNUSED palette colour for this site, so the swatch is never empty
    // and a new lift differs from its siblings. Robust to deletes/re-adds (unlike count-based).
    // Falls back to count-cycling only if all palette colours are already in use.
    // (Overridable via the PATCH colour picker.)
    const used = new Set(
      ((await prisma.resource.findMany({ where: { site_id }, select: { colour: true } })) as Array<{ colour: string | null }>)
        .map((r) => r.colour)
        .filter(Boolean) as string[]
    );
    const colour =
      RESOURCE_PALETTE.find((c) => !used.has(c)) ??
      RESOURCE_PALETTE[(await prisma.resource.count({ where: { site_id } })) % RESOURCE_PALETTE.length];
    const created = await prisma.resource.create({
      data: { site_id, name: cleanName, type: type as ResourceType, colour, ...(order !== null ? { display_order: order } : {}) },
      select: { id: true },
    });
    return res.status(201).json({ id: created.id, message: 'Resource created.' });
  }

  if (req.method === 'PATCH') {
    const { id, name, type, display_order, is_active, colour } = (req.body || {}) as {
      id?: string; name?: string; type?: string; display_order?: number | string; is_active?: boolean; colour?: string | null;
    };
    if (!id) return res.status(400).json({ message: 'Missing id.' });
    if (!(await ownResource(id))) return res.status(404).json({ message: 'Resource not found.' });
    if (type !== undefined && !VALID_TYPES.includes(type)) {
      return res.status(400).json({ message: `Type must be one of: ${VALID_TYPES.join(', ')}.` });
    }
    if (colour !== undefined && colour !== null && !isValidPaletteColour(colour)) {
      return res.status(400).json({ message: 'Colour must be one of the curated palette values.' });
    }
    const data: any = {};
    if (colour !== undefined) data.colour = colour; // string (palette) or null to clear
    if (name !== undefined) {
      const cleanName = name.trim();
      if (!cleanName) return res.status(400).json({ message: 'Name cannot be empty.' });
      data.name = cleanName;
    }
    if (type !== undefined) data.type = type as ResourceType;
    if (display_order !== undefined) {
      const order = parseOrder(display_order);
      if (order === null) return res.status(400).json({ message: 'Invalid display order.' });
      data.display_order = order;
    }
    if (is_active !== undefined) data.is_active = !!is_active;
    await prisma.resource.update({ where: { id }, data });
    return res.status(200).json({ message: 'Resource updated.' });
  }

  if (req.method === 'DELETE') {
    const id = (req.query.id as string) || (req.body && (req.body.id as string));
    if (!id) return res.status(400).json({ message: 'Missing id.' });
    if (!(await ownResource(id))) return res.status(404).json({ message: 'Resource not found.' });
    await prisma.resource.delete({ where: { id } });
    return res.status(200).json({ message: 'Resource deleted.' });
  }

  res.setHeader('Allow', 'POST, PATCH, DELETE');
  return res.status(405).json({ message: 'Method Not Allowed' });
}
