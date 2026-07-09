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
  standardViewInvoices: boolean;   // STANDARD may open the Invoices (AR) view — amounts included, binary
  // Diary financial visibility, per role (ADMIN/owner always sees both — see financeVisibility).
  managerSeeValues: boolean; managerSeeMargin: boolean;
  standardSeeValues: boolean; standardSeeMargin: boolean;
};

const OFF: TenantPermissions = {
  standardEditPricing: false, standardDiaryEntries: false, standardViewInvoices: false,
  managerSeeValues: false, managerSeeMargin: false, standardSeeValues: false, standardSeeMargin: false,
};

export async function getTenantPermissions(groupId: string | null | undefined): Promise<TenantPermissions> {
  if (!groupId) return OFF;
  const g = (await prisma.group.findUnique({
    where: { id: groupId },
    select: {
      perm_standard_edit_pricing: true, perm_standard_diary_entries: true, perm_standard_view_invoices: true,
      perm_manager_see_values: true, perm_manager_see_margin: true,
      perm_standard_see_values: true, perm_standard_see_margin: true,
    },
  })) as any;
  if (!g) return OFF;
  return {
    standardEditPricing: !!g.perm_standard_edit_pricing, standardDiaryEntries: !!g.perm_standard_diary_entries,
    standardViewInvoices: !!g.perm_standard_view_invoices,
    managerSeeValues: !!g.perm_manager_see_values, managerSeeMargin: !!g.perm_manager_see_margin,
    standardSeeValues: !!g.perm_standard_see_values, standardSeeMargin: !!g.perm_standard_see_margin,
  };
}

// Diary financial visibility for a user. ADMIN/owner always sees both (they own the business + author
// the config). SITE_MANAGER / STANDARD are gated by the per-tenant, per-role toggles. THE one place the
// SSR decides which financial numbers a user may RECEIVE — a role without a flag is never sent them.
export type FinanceVisibility = { seeValues: boolean; seeMargin: boolean };
export function financeVisibility(vis: Visibility, perms: TenantPermissions): FinanceVisibility {
  if (vis.isAdmin) return { seeValues: true, seeMargin: true };
  if (vis.role === 'SITE_MANAGER') return { seeValues: perms.managerSeeValues, seeMargin: perms.managerSeeMargin };
  return { seeValues: perms.standardSeeValues, seeMargin: perms.standardSeeMargin };
}

// Edit an estimate/pricing on a card at `siteId`: managers/admins always; STANDARD only if the
// tenant toggle is on AND they're assigned to that site.
export function canEditEstimate(vis: Visibility, siteId: string | null | undefined, perms: TenantPermissions): boolean {
  return canManageSite(vis, siteId) || (perms.standardEditPricing && canAccessSite(vis, siteId));
}

// Open the Invoices (AR/debtors) view at all: managers/admins always; STANDARD only via the tenant
// toggle. Row scope is ALWAYS vis.siteIds regardless — the toggle never widens site access.
export function canViewInvoices(vis: Visibility, perms: TenantPermissions): boolean {
  if (vis.isAdmin || vis.role === 'SITE_MANAGER') return vis.siteIds.length > 0;
  return perms.standardViewInvoices && vis.siteIds.length > 0;
}

// Create a diary entry / add-edit a note at `siteId`: managers/admins always; STANDARD only if the
// tenant toggle is on AND they're assigned to that site.
export function canCreateDiaryEntry(vis: Visibility, siteId: string | null | undefined, perms: TenantPermissions): boolean {
  return canManageSite(vis, siteId) || (perms.standardDiaryEntries && canAccessSite(vis, siteId));
}
