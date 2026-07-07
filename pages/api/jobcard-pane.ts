/**
 * File: pages/api/jobcard-pane.ts
 * GET ?id= → the full job-card workspace props as JSON, for the diary's desktop-day INLINE card pane.
 * Same builder as the standalone card page (lib/jobcard-page-data.ts) — one data shape, one component,
 * so the inline card can never drift from the routed page. Visibility enforced inside the builder
 * (card must be on a site the caller can see). Never cached.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/pages/api/auth/[...nextauth]';
import { buildJobCardPageProps } from '@/lib/jobcard-page-data';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET') { res.setHeader('Allow', 'GET'); return res.status(405).json({ message: 'Method Not Allowed' }); }
  const session = await getServerSession(req, res, authOptions);
  const user = session?.user as any;
  if (!user?.id || !user?.group_id) return res.status(401).json({ message: 'Not authenticated.' });

  const id = String(req.query.id || '');
  if (!id) return res.status(400).json({ message: 'Missing id.' });
  const props = await buildJobCardPageProps(user.id as string, user.group_id as string, id);
  if (!props) return res.status(404).json({ message: 'Job card not found.' });
  return res.status(200).json(props);
}
