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

  // ── TWO LISTS, TWO QUESTIONS. Do not collapse them. ──────────────────────────────────────────
  // siteIds = AUTHORISATION ENVELOPE: "whose data may this user READ?" — INCLUDES ARCHIVED sites.
  //   Every historical/financial read uses this. Filtering archived out here would silently drop an
  //   archived site's past invoices from the P&L and VAT return — a closed month would change value
  //   because of a UI action taken today. That is the failure this split exists to prevent.
  // activeSiteIds = OPERATIONAL SET: "where may this user START NEW WORK / what appears in pickers?"
  //   Archived sites are absent. Use for site pickers, diary resolution, job-card creation targets,
  //   booking placement, assignment checkboxes.
  // Rule of thumb: reading the past → siteIds. Doing something new → activeSiteIds.
  siteIds: string[];
  activeSiteIds: string[];
  primarySiteId: string | null; // default landing site — prefers an ACTIVE site (never lands on an archive)
};

export async function getVisibility(userId: string): Promise<Visibility> {
  const empty: Visibility = { userId, groupId: null, role: 'STANDARD', isOwner: false, isAdmin: false, canInvoice: false, siteIds: [], activeSiteIds: [], primarySiteId: null };
  if (!userId) return empty;

  const user = (await prisma.user.findUnique({
    where: { id: userId },
    select: { group_id: true, role: true, is_owner: true, can_invoice: true, primary_site_id: true, site_id: true, site_assignments: { select: { site_id: true } } },
  })) as { group_id: string | null; role: 'ADMIN' | 'SITE_MANAGER' | 'STANDARD'; is_owner: boolean; can_invoice: boolean; primary_site_id: string | null; site_id: string | null; site_assignments: Array<{ site_id: string }> } | null;

  if (!user) return empty;
  const isAdmin = user.role === 'ADMIN' || user.is_owner;

  // Read id + is_active together so the two lists come from ONE query, not two that could disagree.
  let siteIds: string[];
  let activeSiteIds: string[];
  if (isAdmin && user.group_id) {
    const sites = (await prisma.site.findMany({ where: { group_id: user.group_id }, select: { id: true, is_active: true } })) as Array<{ id: string; is_active: boolean }>;
    siteIds = sites.map((s) => s.id);
    activeSiteIds = sites.filter((s) => s.is_active).map((s) => s.id);
  } else {
    siteIds = user.site_assignments.map((a) => a.site_id);
    const active = siteIds.length
      ? ((await prisma.site.findMany({ where: { id: { in: siteIds }, is_active: true }, select: { id: true } })) as Array<{ id: string }>)
      : [];
    activeSiteIds = active.map((s) => s.id);
  }

  // Primary = admin-set landing site if still accessible, else the active site, else first accessible.
  // Prefers the ACTIVE list at each step so a user whose home site was archived lands somewhere real;
  // falls back to siteIds only when EVERY accessible site is archived (better than landing nowhere).
  const prefs = [user.primary_site_id, user.site_id];
  const primarySiteId =
    prefs.find((id) => id && activeSiteIds.includes(id)) ??
    activeSiteIds[0] ??
    prefs.find((id) => id && siteIds.includes(id)) ??
    siteIds[0] ??
    null;

  // can_invoice is a STANDARD/manager grant; ADMIN already outranks it (canManageSite covers issue).
  return { userId, groupId: user.group_id, role: user.role, isOwner: user.is_owner, isAdmin, canInvoice: !!user.can_invoice, siteIds, activeSiteIds, primarySiteId };
}

export async function canAccessSite(userId: string, siteId: string | null | undefined): Promise<boolean> {
  if (!siteId) return false;
  const vis = await getVisibility(userId);
  return vis.siteIds.includes(siteId);
}
