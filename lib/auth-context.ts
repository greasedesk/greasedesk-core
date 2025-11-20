/**
 * File: lib/auth-context.ts
 * Last edited: 2025-11-20 12:25 Europe/London
 *
 * Helper: fetches a typed NextAuth session plus the latest group/site
 * context for the current user. Used by API routes instead of duplicating
 * session + user lookup logic everywhere.
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/pages/api/auth/[...nextauth]';
import { prisma } from '@/lib/db';

export type AuthContext = {
  session: Awaited<ReturnType<typeof getServerSession>>;
  groupId: string | null;
  siteId: string | null;
};

/**
 * Require an authenticated user and return their session plus
 * the latest group/site IDs from the database.
 *
 * Throws an Error if no valid session is found.
 */
export async function requireAuthContext(
  req: NextApiRequest,
  res: NextApiResponse
): Promise<AuthContext> {
  const session = await getServerSession(req, res, authOptions);

  if (!session?.user?.id) {
    throw new Error('Authentication Error: user session not found');
  }

  const dbUser = await prisma.user.findUnique({
    where: { id: session.user.id as string },
    select: { group_id: true, site_id: true },
  });

  return {
    session,
    groupId: dbUser?.group_id ?? null,
    siteId: dbUser?.site_id ?? null,
  };
}
