-- Margin visibility is a DELIBERATE tenant decision, never an inherited default (ruling 2026-07-12):
-- flip the manager see-margin default to OFF and reset every existing tenant to OFF. A tenant who
-- wants a site manager to see trade costs switches it on in Settings → Permissions, on purpose.
ALTER TABLE "Group" ALTER COLUMN "perm_manager_see_margin" SET DEFAULT false;
UPDATE "Group" SET "perm_manager_see_margin" = false;
