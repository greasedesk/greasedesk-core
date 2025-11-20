/**
 * File: lib/auth-context.ts
 * Last edited: 2025-11-20 12:20 Europe/London
 *
 * Description:
 *  Small helper for API routes:
 *    - Validates the NextAuth session
 *    - Loads the latest user record (with group_id / site_id)
 *    - Throws clear errors if anything is missing
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
};

export type AuthContext = {
  session: Awaited<ReturnType<typeof getServerSession>>;
  user: AuthContextUser;
};

export async function requireAuthContext(
  req: NextApiRequest,
  res: NextApiResponse
): Promise<AuthContext> {
  const session = await getServerSession(req, res, authOptions);

  if (!session || !session.user || !session.user.email) {
    throw new Error('UNAUTHENTICATED: No valid session found.');
  }

  const user = await prisma.user.findUnique({
    where: { email: session.user.email },
    select: {
      id: true,
      email: true,
      group_id: true,
      site_id: true,
    },
  });

  if (!user) {
    throw new Error('UNAUTHENTICATED: User record not found.');
  }

  return { session, user };
}
