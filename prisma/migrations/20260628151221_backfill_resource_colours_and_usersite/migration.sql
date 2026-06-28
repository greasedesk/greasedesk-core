-- Data backfill only (no schema change). Idempotent / safe to re-run.
-- 1) Assign cycling palette colours to existing NULL-colour resources, per site.
-- 2) Seed UserSite from each user's current site_id.
-- These ran as ad-hoc scripts on dev only; this committed migration applies them on prod
-- via `prisma migrate deploy`.

-- 1) Resource colours: number each site's NULL-colour resources (by display_order, then
--    created_at) and assign palette[(rn % 10)]. Only touches colour IS NULL → re-run is a no-op.
WITH palette AS (
  SELECT ARRAY[
    '#3B82F6','#10B981','#F59E0B','#EF4444','#8B5CF6',
    '#EC4899','#14B8A6','#F97316','#6366F1','#84CC16'
  ]::text[] AS p
),
ranked AS (
  SELECT
    r.id,
    (ROW_NUMBER() OVER (PARTITION BY r.site_id ORDER BY r.display_order, r.created_at) - 1) AS rn
  FROM "Resource" r
  WHERE r.colour IS NULL
)
UPDATE "Resource" r
SET colour = (SELECT p FROM palette)[(ranked.rn % 10) + 1]  -- Postgres arrays are 1-indexed
FROM ranked
WHERE r.id = ranked.id;

-- 2) UserSite from each user's active site_id. ON CONFLICT on the composite PK → re-run safe.
INSERT INTO "UserSite" ("user_id", "site_id")
SELECT u."id", u."site_id"
FROM "User" u
WHERE u."site_id" IS NOT NULL
ON CONFLICT ("user_id", "site_id") DO NOTHING;
