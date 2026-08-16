/**
 * File: pages/api/messages/read.ts
 * Clear a thread's unread count. Attributed to whoever opened it — clearing unread is an act by a
 * person, and last_read_by records which. Tenant-scoped; a thread from another tenant is a 404.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { requireTenantApi } from '@/lib/admin-guard';
import { prisma } from '@/lib/db';
import { markThreadRead, unreadThreadCount } from '@/lib/message-threads';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).json({ message: 'Method Not Allowed' }); }
  const scope = await requireTenantApi(req, res);
  if (!scope) return;
  const threadId = String((req.body ?? {}).threadId ?? '');
  if (!threadId) return res.status(400).json({ message: 'Missing threadId.' });
  const t = await prisma.messageThread.findFirst({ where: { id: threadId, group_id: scope.groupId }, select: { id: true } });
  if (!t) return res.status(404).json({ message: 'Conversation not found.' });
  await markThreadRead(prisma, t.id, scope.userId);
  return res.status(200).json({ ok: true, unread: await unreadThreadCount(prisma, scope.groupId) });
}
