-- Additive/non-destructive: per-tenant permission toggles (default OFF → current manager-only
-- behaviour preserved). Resolved via lib/permissions.ts and read inside the permission chokepoints.
ALTER TABLE "Group" ADD COLUMN "perm_standard_edit_pricing"  BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Group" ADD COLUMN "perm_standard_diary_entries" BOOLEAN NOT NULL DEFAULT false;
