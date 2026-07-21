/**
 * File: lib/owner-lockout.ts
 * THE lockout invariant, kept dependency-free so it is unit-testable in isolation. Would suspending
 * or demoting `targetId` leave the platform with ZERO active owners? Removing the target from the
 * current active-owner set must not empty it. The operator-management API applies this before any
 * suspend/role-change of an active owner; the self-suspend / self-demote guards are the friendlier
 * subset of the same protection.
 */
export function leavesZeroActiveOwners(activeOwnerIds: string[], targetId: string): boolean {
  return activeOwnerIds.filter((id) => id !== targetId).length === 0;
}
