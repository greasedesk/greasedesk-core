/**
 * File: lib/auth-context.ts
 * Last edited: 2025-11-18 18:09 Europe/London
 *
 * Provides guaranteed multi-tenant-safe auth context for API routes.
 * Replaces trust-in-session with DB-verified tenant scoping.
 */

import { getServerSession } from 'next-auth';
import { authOptions } from '@/pages/api/auth/[...nextauth]';
import { prisma } from '@/lib/db';

export async function requireAuthContext(req, res) {
  const session = await getServerSession(req, res, authOptions);

  if (!session?.user?.id) {
    throw new Error('Not authenticated');
  }

  // ALWAYS resolve tenant context from DB to avoid forged session tokens
  const user = await prisma.user.findUnique({
    where: { id: session.user.id },
    select: { id: true, group_id: true, site_id: true },
  });

  if (!user?.group_id) {
    throw new Error('User missing tenant context');
  }

  return {
    userId: user.id,
    groupId: user.group_id,
    siteId: user.site_id ?? undefined,
  };
}
