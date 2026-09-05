/**
 * File: lib/operator-roles.ts
 * THE OPERATOR ROLE LADDER AND THE ENGINE ROOM NAV — pure, and in their own module for one reason.
 *
 * ── WHY THIS IS NOT IN lib/operator-auth ────────────────────────────────────────────────────────
 * operator-auth imports `prisma` at module scope, because that is where the session guards live.
 * EngineRoomLayout is a CLIENT component rendered on every Engine Room page, and it imported
 * `erNavFor` — a value — from there. That pulled the whole module, prisma included, into the
 * browser bundle, and every Engine Room page threw:
 *
 *     PrismaClient is unable to run in this browser environment, or has been bundled for the browser
 *
 * The pages still rendered (the server had already done that), so it looked like nothing was wrong
 * until a gate tried to CLICK something and found Next's dev error overlay covering the portal.
 *
 * So the pure half lives here, with no imports at all, and operator-auth re-exports it so every
 * existing server-side caller is untouched. Exactly the arrangement owner-lockout already has, and
 * for the same reason: a dependency-free module can be imported from anywhere.
 *
 * A CLIENT COMPONENT MUST IMPORT FROM HERE, never from operator-auth.
 */

export type OperatorRoleName = 'owner' | 'country_manager' | 'support';
export type OperatorPrincipal = { userId: string; role: OperatorRoleName; regions: string[] };

const RANK: Record<OperatorRoleName, number> = { support: 1, country_manager: 2, owner: 3 };
export function roleAtLeast(role: OperatorRoleName, min: OperatorRoleName): boolean {
  return RANK[role] >= RANK[min];
}

// The lockout invariant lives in a dependency-free module (unit-testable in isolation), re-exported
// here so callers keep importing it from operator-auth.
export { leavesZeroActiveOwners } from './owner-lockout';

/**
 * THE role → landing map for the Engine Room front door (er.greasedesk.com/). Owner and Country
 * Manager land on the DASHBOARD (the home screen); Support lands on the read-only Tenants list.
 * One source of truth so /superadmin (the front door) and the login redirect agree.
 */
export function operatorLanding(role: OperatorRoleName): string {
  return role === 'support' ? '/superadmin/tenants' : '/superadmin/dashboard';
}

/**
 * THE Engine Room nav — one definition drives BOTH the rendered sidebar (filtered by role, so a link
 * a role would 404 on is never shown) AND each screen's own guard (via erMinRole). Nav-visibility and
 * the server guard reading from the same source is what keeps "hidden link is not a guard" honest:
 * the link is filtered here, and the page independently enforces the SAME minRole in getServerSideProps.
 * Settings + Sign out are pinned separately in the layout (Settings is all-roles).
 */
export type ErNavItem = { href: string; label: string; minRole: OperatorRoleName };
export const ER_NAV: ErNavItem[] = [
  { href: '/superadmin/dashboard', label: 'Dashboard', minRole: 'support' },
  { href: '/superadmin/tenants', label: 'Tenants', minRole: 'support' },
  { href: '/superadmin/operators', label: 'Operators', minRole: 'owner' },
  { href: '/superadmin/reps', label: 'Reps', minRole: 'country_manager' },
  { href: '/superadmin/rates', label: 'Rates', minRole: 'owner' },
  // Content (legal + marketing pages). The SCREEN is owner + CM (Support 404s); within it, `legal`
  // actions are Owner-only, enforced server-side in the API — a CM can edit `page`, not `legal`.
  { href: '/superadmin/content', label: 'Content', minRole: 'country_manager' },
  // Setup-wizard step definitions (wording/order/scope) — Owner only; handler bindings are code.
  { href: '/superadmin/setup-steps', label: 'Setup steps', minRole: 'owner' },
];
export const erNavFor = (role: OperatorRoleName): ErNavItem[] => ER_NAV.filter((i) => roleAtLeast(role, i.minRole));
/** The minRole a route requires — the SAME value its page passes to requireOperatorPage. */
export const erMinRole = (href: string): OperatorRoleName => ER_NAV.find((i) => i.href === href)?.minRole ?? 'support';
