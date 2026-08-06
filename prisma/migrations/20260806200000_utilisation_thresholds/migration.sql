-- Additive, nullable, with defaults. Existing tenants get 50/75 — the same judgement the light
-- would apply with no configuration at all, so nothing changes for anyone until they change it.
ALTER TABLE "Group" ADD COLUMN "util_red_below" INTEGER DEFAULT 50;
ALTER TABLE "Group" ADD COLUMN "util_amber_below" INTEGER DEFAULT 75;
