/**
 * File: pages/api/demo-status.ts
 * GET → is this tenant a demo, and how long has it got? For the shell banner.
 *
 * Mirrors pages/api/billing-gate: fetched once per session by a component mounted in AdminLayout,
 * not per navigation. Reads lib/demo-lifecycle, so the banner counts down to the same instant the
 * cron deletes at — a banner saying "2 days left" over a tenant about to be purged would be worse
 * than no banner.
 *
 * No admin requirement. Every signed-in user of a demo should be told it is temporary.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { prisma } from '@/lib/db';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/pages/api/auth/[...nextauth]';
import { demoLifecycle } from '@/lib/demo-lifecycle';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET') { res.setHeader('Allow', 'GET'); return res.status(405).end(); }
  const session = await getServerSession(req, res, authOptions);
  const user = session?.user as any;
  if (!user?.id || !user?.group_id) return res.status(401).json({ message: 'Not authenticated.' });

  const g = await prisma.group.findUnique({
    where: { id: user.group_id as string }, select: { is_demo: true, demo_expires_at: true },
  });
  const life = demoLifecycle(g as any);
  return res.status(200).json({
    isDemo: !!(g as any)?.is_demo,
    phase: life.phase,
    daysLeft: life.daysLeft,
    expiresAt: life.expiresAt ? life.expiresAt.toISOString() : null,
  });
}
