/**
 * File: lib/site-visibility.ts
 * THE single chokepoint for role/assignment site-visibility.
 *
 * ADMIN or owner → every site in their group.
 * STANDARD       → only the site(s) they're assigned to (via UserSite).
 *
 * Reads role/owner/assignments from the DB per request (not the session token, which can be
 * stale after a role change). Every site-scoped view and endpoint routes through this — no
 * scattered inline role checks.
 */
import { prisma } from '@/lib/db';

export type Visibility = {
  userId: string;
  groupId: string | null;
  role: 'ADMIN' | 'STANDARD';
  isOwner: boolean;
  isAdmin: boolean;      // ADMIN or owner → sees all group sites
  siteIds: string[];     // the sites this user may see/act on
};

export async function getVisibility(userId: string): Promise<Visibility> {
  const empty: Visibility = { userId, groupId: null, role: 'STANDARD', isOwner: false, isAdmin: false, siteIds: [] };
  if (!userId) return empty;

  const user = (await prisma.user.findUnique({
    where: { id: userId },
    select: { group_id: true, role: true, is_owner: true, site_assignments: { select: { site_id: true } } },
  })) as { group_id: string | null; role: 'ADMIN' | 'STANDARD'; is_owner: boolean; site_assignments: Array<{ site_id: string }> } | null;

  if (!user) return empty;
  const isAdmin = user.role === 'ADMIN' || user.is_owner;

  let siteIds: string[];
  if (isAdmin && user.group_id) {
    const sites = (await prisma.site.findMany({ where: { group_id: user.group_id }, select: { id: true } })) as Array<{ id: string }>;
    siteIds = sites.map((s) => s.id);
  } else {
    siteIds = user.site_assignments.map((a) => a.site_id);
  }

  return { userId, groupId: user.group_id, role: user.role, isOwner: user.is_owner, isAdmin, siteIds };
}

export async function canAccessSite(userId: string, siteId: string | null | undefined): Promise<boolean> {
  if (!siteId) return false;
  const vis = await getVisibility(userId);
  return vis.siteIds.includes(siteId);
}
