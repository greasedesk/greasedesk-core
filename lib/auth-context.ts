// File: lib/auth-context.ts - Agent Fix: 2025-12-14

/**
 * Helper: Require an authenticated user and return their core context
 * (user id, group id, site id, role, garageName) for API routes.
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
  role: string; // e.g., 'admin', 'owner', 'user', 'mechanic'
  garageName: string | null; // Added for garage assignment check
}

/**
 * Require a valid NextAuth session and resolve the current user record and AuthContext.
 * Throws if there is no logged-in user or if the user is not assigned to a garage.
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
    select: {
      id: true,
      email: true,
      role: true,
      garageId: true,
      garageName: true,
      group_id: true,
      site_id: true,
    },
  });

  if (!user) {
    throw new Error('Authenticated user record not found');
  }

  // ✅ Multi-Tenant Security Check (GreaseDesk Blueprint Requirement)
  // Throw error if user is not assigned to a garage (Tenant)
  if (!user.garageName) {
    throw new Error('User is not assigned to a garage');
  }

  return {
    sessionUserId: sessionUserId ?? user.id,
    userId: user.id,
    groupId: user.group_id ?? null,
    siteId: user.site_id ?? null,
    role: user.role,
    garageName: user.garageName,
  };
}