/**
 * File: pages/api/messages/unread.ts
 * The unread count for the nav pill. Read-only, tenant-scoped, deliberately tiny.
 *
 * It exists because the SHELL must own this number, not a page. The count used to arrive as a prop
 * from /admin/messages, which forced that page to mount its own AdminLayout — and mounting a second
 * shell inside the persistent one rendered the whole navigation twice. It also meant the pill only
 * existed on the Messages page, which is the one page where you already know.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { prisma } from '@/lib/db';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/pages/api/auth/[...nextauth]';
import { unreadThreadCount } from '@/lib/message-threads';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') { res.setHeader('Allow', 'GET'); return res.status(405).json({ message: 'Method Not Allowed' }); }
  const session = await getServerSession(req, res, authOptions);
  const user = session?.user as any;
  // Not signed in is not an error for a nav decoration — it is simply no count.
  if (!user?.group_id) return res.status(200).json({ unread: null });
  return res.status(200).json({ unread: await unreadThreadCount(prisma, user.group_id as string) });
}
