/**
 * File: lib/auth-context.ts
 * Last edited: 2025-11-20 12:10 Europe/London
 *
 * Description: Shared helper for API routes to:
 *  - Validate the current NextAuth session
 *  - Load a fresh user record (with group/site ids)
 *  - Throw a clear error if anything is missing
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/pages/api/auth/[...nextauth]';
import { prisma } from '@/lib/db';

export type AuthContextUser = {
  id: string;
  email: string | null;
  group_id: string | null;
  site_id: string | null;
  role: string | null;
};

export type AuthContext = {
  session: Awaited<ReturnType<typeof getServerSession>>;
  user: AuthContextUser;
};

/**
 * requireAuthContext
 *
 * Usage in an API route:
 *
 *    const { session, user } = await requireAuthContext(req, res);
 *    // user.group_id / user.site_id are safe to use from here.
 */
export async function requireAuthContext(
  req: NextApiRequest,
  res: NextApiResponse
): Promise<AuthContext> {
  const session = await getServerSession(req, res, authOptions);

  if (!session || !session.user || !session.user.email) {
    throw new Error('UNAUTHENTICATED: No valid session found.');
  }

  const dbUser = await prisma.user.findUnique({
    where: { email: session.user.email },
    select: {
      id: true,
      email: true,
      group_id: true,
      site_id: true,
      role: true,
    },
  });

  if (!dbUser) {
    throw new Error('UNAUTHENTICATED: User record not found.');
  }

  return {
    session,
    user: dbUser,
  };
}
