/**
 * File: pages/api/messages/read.ts
 * Clear a thread's unread count. Attributed to whoever opened it — clearing unread is an act by a
 * person, and last_read_by records which. Tenant-scoped; a thread from another tenant is a 404.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { prisma } from '@/lib/db';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/pages/api/auth/[...nextauth]';
import { markThreadRead, unreadThreadCount } from '@/lib/message-threads';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).json({ message: 'Method Not Allowed' }); }
  const session = await getServerSession(req, res, authOptions);
  const user = session?.user as any;
  if (!user?.id || !user?.group_id) return res.status(401).json({ message: 'Not authenticated.' });
  const threadId = String((req.body ?? {}).threadId ?? '');
  if (!threadId) return res.status(400).json({ message: 'Missing threadId.' });
  const t = await prisma.messageThread.findFirst({ where: { id: threadId, group_id: user.group_id as string }, select: { id: true } });
  if (!t) return res.status(404).json({ message: 'Conversation not found.' });
  await markThreadRead(prisma, t.id, user.id as string);
  return res.status(200).json({ ok: true, unread: await unreadThreadCount(prisma, user.group_id as string) });
}
