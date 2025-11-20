/**
 * File: lib/auth-context.ts
 * Last edited: 2025-11-20 12:50 Europe/London
 *
 * Helper: Require an authenticated user and return their core context
 * (user id, group id, site id) for API routes...
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/pages/api/auth/[...nextauth]';
import { prisma } from '@/lib/db';

export interface AuthContext {
  sessionUserId: string;
  userId: string;
  groupId: string | null;
  siteId: string | null;
}

/**
 * Require a valid NextAuth session and resolve the current user record.
 * Throws if there is no logged-in user.
 */
export async function requireAuthContext(
  req: NextApiRequest,
  res: NextApiResponse
): Promise<AuthContext> {
  const session = await getServerSession(req, res, authOptions);

  if (!session?.user) {
    throw new Error('Not authenticated');
  }

  const sessionUserId = (session.user as any).id as string | undefined;
  const sessionEmail = session.user.email ?? undefined;

  // Look up the user either by id (preferred) or by email
  const user = await prisma.user.findFirst({
    where: {
      OR: [
        sessionUserId ? { id: sessionUserId } : undefined,
        sessionEmail ? { email: sessionEmail } : undefined,
      ].filter(Boolean) as any,
    },
  });

  if (!user) {
    throw new Error('Authenticated user record not found');
  }

  return {
    sessionUserId: sessionUserId ?? user.id,
    userId: user.id,
    groupId: (user as any).group_id ?? null,
    siteId: (user as any).site_id ?? null,
  };
}
