-- Diary financial-visibility permissions, per role. Additive (defaults preserve intent:
-- managers see values + margin, standard users see neither until an admin opts them in).
ALTER TABLE "Group" ADD COLUMN "perm_manager_see_values"  BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "Group" ADD COLUMN "perm_manager_see_margin"  BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "Group" ADD COLUMN "perm_standard_see_values" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Group" ADD COLUMN "perm_standard_see_margin" BOOLEAN NOT NULL DEFAULT false;
