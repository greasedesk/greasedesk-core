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
  role: 'ADMIN' | 'SITE_MANAGER' | 'STANDARD';
  isOwner: boolean;
  isAdmin: boolean;      // ADMIN or owner → sees all group sites (SITE_MANAGER is NOT admin)
  canInvoice: boolean;   // per-user grant: may RAISE an invoice at an assigned site (see canIssueInvoice)
  siteIds: string[];     // the sites this user may see/act on
  primarySiteId: string | null; // the user's default landing site (falls back to first accessible)
};

export async function getVisibility(userId: string): Promise<Visibility> {
  const empty: Visibility = { userId, groupId: null, role: 'STANDARD', isOwner: false, isAdmin: false, canInvoice: false, siteIds: [], primarySiteId: null };
  if (!userId) return empty;

  const user = (await prisma.user.findUnique({
    where: { id: userId },
    select: { group_id: true, role: true, is_owner: true, can_invoice: true, primary_site_id: true, site_id: true, site_assignments: { select: { site_id: true } } },
  })) as { group_id: string | null; role: 'ADMIN' | 'SITE_MANAGER' | 'STANDARD'; is_owner: boolean; can_invoice: boolean; primary_site_id: string | null; site_id: string | null; site_assignments: Array<{ site_id: string }> } | null;

  if (!user) return empty;
  const isAdmin = user.role === 'ADMIN' || user.is_owner;

  let siteIds: string[];
  if (isAdmin && user.group_id) {
    const sites = (await prisma.site.findMany({ where: { group_id: user.group_id }, select: { id: true } })) as Array<{ id: string }>;
    siteIds = sites.map((s) => s.id);
  } else {
    siteIds = user.site_assignments.map((a) => a.site_id);
  }

  // Primary = admin-set landing site if it's still accessible, else the active site, else first accessible.
  const prefs = [user.primary_site_id, user.site_id];
  const primarySiteId = prefs.find((id) => id && siteIds.includes(id)) ?? siteIds[0] ?? null;

  // can_invoice is a STANDARD/manager grant; ADMIN already outranks it (canManageSite covers issue).
  return { userId, groupId: user.group_id, role: user.role, isOwner: user.is_owner, isAdmin, canInvoice: !!user.can_invoice, siteIds, primarySiteId };
}

export async function canAccessSite(userId: string, siteId: string | null | undefined): Promise<boolean> {
  if (!siteId) return false;
  const vis = await getVisibility(userId);
  return vis.siteIds.includes(siteId);
}
