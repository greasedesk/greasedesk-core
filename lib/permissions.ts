/**
 * File: lib/permissions.ts
 * THE single place tenant permission toggles are resolved. The role model (ADMIN/SITE_MANAGER/
 * STANDARD) is the default; these admin-set, per-tenant toggles relax specific STANDARD boundaries.
 * The toggle-aware authority predicates compose the existing chokepoints (canManageSite/canAccessSite)
 * so a toggle NEVER grants cross-site access — a STANDARD user still needs membership of the site.
 *
 * Adding a future toggle = add a Group column, a field here, and a predicate (if it needs one).
 */
import { prisma } from '@/lib/db';
import { Visibility } from '@/lib/site-visibility';
import { canManageSite, canAccessSite } from '@/lib/admin-guard';

export type TenantPermissions = {
  standardEditPricing: boolean;    // STANDARD may edit estimates/pricing on job cards
  standardDiaryEntries: boolean;   // STANDARD may add/edit diary notes + create entries from the diary
};

const OFF: TenantPermissions = { standardEditPricing: false, standardDiaryEntries: false };

export async function getTenantPermissions(groupId: string | null | undefined): Promise<TenantPermissions> {
  if (!groupId) return OFF;
  const g = (await prisma.group.findUnique({
    where: { id: groupId },
    select: { perm_standard_edit_pricing: true, perm_standard_diary_entries: true },
  })) as { perm_standard_edit_pricing: boolean; perm_standard_diary_entries: boolean } | null;
  if (!g) return OFF;
  return { standardEditPricing: !!g.perm_standard_edit_pricing, standardDiaryEntries: !!g.perm_standard_diary_entries };
}

// Edit an estimate/pricing on a card at `siteId`: managers/admins always; STANDARD only if the
// tenant toggle is on AND they're assigned to that site.
export function canEditEstimate(vis: Visibility, siteId: string | null | undefined, perms: TenantPermissions): boolean {
  return canManageSite(vis, siteId) || (perms.standardEditPricing && canAccessSite(vis, siteId));
}

// Create a diary entry / add-edit a note at `siteId`: managers/admins always; STANDARD only if the
// tenant toggle is on AND they're assigned to that site.
export function canCreateDiaryEntry(vis: Visibility, siteId: string | null | undefined, perms: TenantPermissions): boolean {
  return canManageSite(vis, siteId) || (perms.standardDiaryEntries && canAccessSite(vis, siteId));
}
