/**
 * File: pages/api/status-colours.ts
 * GET  → the tenant's resolved diary status-band colours (defaults merged under any stored overrides).
 * PATCH { colours } → ADMIN-only save of the whole band→colour map. { reset: true } → clear to defaults.
 *
 * Values are constrained to the curated RESOURCE_PALETTE (lib/diary-colours) — off-palette hex is
 * rejected, so a fill can never be white-on-white. One palette per tenant (Group.status_colours).
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/pages/api/auth/[...nextauth]';
import { getVisibility } from '@/lib/site-visibility';
import { RESOURCE_PALETTE } from '@/lib/diary-colours';
import { STATUS_BANDS, resolveStatusColours, isStatusBand } from '@/lib/status-colours';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const session = await getServerSession(req, res, authOptions);
  const user = session?.user as any;
  if (!user?.id || !user?.group_id) return res.status(401).json({ message: 'Not authenticated.' });

  if (req.method === 'GET') {
    const grp = (await prisma.group.findUnique({ where: { id: user.group_id }, select: { status_colours: true } })) as any;
    return res.status(200).json({ colours: resolveStatusColours(grp?.status_colours) });
  }

  if (req.method === 'PATCH') {
    const vis = await getVisibility(user.id as string);
    if (!vis.isAdmin) return res.status(403).json({ message: 'Only an admin can change the status colours.' });

    const { colours, reset } = (req.body || {}) as { colours?: Record<string, string>; reset?: boolean };
    if (reset) {
      await prisma.group.update({ where: { id: user.group_id }, data: { status_colours: Prisma.DbNull } }); // DbNull → the COLUMN is null (JsonNull would store the json value `null`)
      return res.status(200).json({ message: 'Colours reset to defaults.', colours: resolveStatusColours(null) });
    }
    // Keep only known bands with an ON-PALETTE hex — off-palette (incl. white) is dropped, never stored.
    const clean: Record<string, string> = {};
    for (const [k, v] of Object.entries(colours || {})) {
      if (isStatusBand(k) && (RESOURCE_PALETTE as readonly string[]).includes(String(v))) clean[k] = String(v);
    }
    if (Object.keys(clean).length !== STATUS_BANDS.length) {
      return res.status(400).json({ message: 'Pick a palette colour for every status band.' });
    }
    await prisma.group.update({ where: { id: user.group_id }, data: { status_colours: clean } });
    return res.status(200).json({ message: 'Status colours saved.', colours: resolveStatusColours(clean) });
  }

  res.setHeader('Allow', 'GET, PATCH');
  return res.status(405).json({ message: 'Method Not Allowed' });
}
