/**
 * File: pages/api/marketing/unactioned.ts
 * GET → { unactioned } — the nav badge.
 *
 * NOT the size of the lists. A count that never falls is one a garage stops seeing within a week,
 * and AdminLayout already carries the other half of that lesson: a badge showing 0 is noise
 * pretending to be information. This one drops as the list is worked and returns as the next car
 * enters the window — see lib/marketing-lists::isUnactioned for what spends a contact record.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/pages/api/auth/[...nextauth]';
import { marketingBadgeCount } from '@/lib/marketing-data';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') { res.setHeader('Allow', 'GET'); return res.status(405).json({ message: 'Method Not Allowed' }); }
  const session = await getServerSession(req, res, authOptions);
  const user = session?.user as any;
  if (!user?.id || !user?.group_id) return res.status(401).json({ message: 'Not authenticated.' });
  return res.status(200).json({ unactioned: await marketingBadgeCount(user.group_id as string, new Date()) });
}
