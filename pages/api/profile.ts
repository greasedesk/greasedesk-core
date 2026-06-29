/**
 * File: pages/api/profile.ts
 * Update a user's profile fields. A user edits their OWN profile; an ADMIN/owner may edit any
 * user in their group (group-scoped). emergency_note is only ever writable by the profile owner
 * or an admin (which is exactly who can reach a given target here). email is NOT editable here.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { prisma } from '@/lib/db';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/pages/api/auth/[...nextauth]';
import { getVisibility } from '@/lib/site-visibility';

const STRING_FIELDS = [
  'name', 'job_title', 'phone', 'address', 'driving_licence_categories',
  'next_of_kin_name', 'next_of_kin_relationship', 'next_of_kin_phone',
  'emergency_note', 'certifications', 'working_hours',
];

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'PATCH') {
    res.setHeader('Allow', 'PATCH');
    return res.status(405).json({ message: 'Method Not Allowed' });
  }
  const session = await getServerSession(req, res, authOptions);
  const sUser = session?.user as any;
  if (!sUser?.id || !sUser?.group_id) return res.status(401).json({ message: 'Not authenticated.' });

  const body = (req.body || {}) as Record<string, unknown>;
  const targetId = (body.userId as string) || (sUser.id as string);

  // Authorisation: self, or an admin editing someone in their own group.
  if (targetId !== sUser.id) {
    const vis = await getVisibility(sUser.id as string);
    if (!vis.isAdmin) return res.status(403).json({ message: 'Only an admin can edit another user.' });
    const inGroup = await prisma.user.findFirst({ where: { id: targetId, group_id: sUser.group_id }, select: { id: true } });
    if (!inGroup) return res.status(404).json({ message: 'User not found.' });
  }

  const data: any = {};
  for (const f of STRING_FIELDS) {
    if (f in body) data[f] = (body[f] == null ? '' : String(body[f]).trim()) || null;
  }
  if ('start_date' in body) {
    const v = body.start_date as string | null;
    if (!v) data.start_date = null;
    else if (/^\d{4}-\d{2}-\d{2}$/.test(v)) data.start_date = new Date(`${v}T00:00:00.000Z`);
    else return res.status(400).json({ message: 'Start date must be YYYY-MM-DD.' });
  }
  if (Object.keys(data).length === 0) return res.status(400).json({ message: 'Nothing to update.' });

  await prisma.user.update({ where: { id: targetId }, data });
  return res.status(200).json({ message: 'Profile saved.' });
}
