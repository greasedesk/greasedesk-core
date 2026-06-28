-- Data backfill only (no schema change). Idempotent / safe to re-run.
-- Owner = earliest-created user per group; owners → ADMIN; everyone else stays STANDARD.

-- Set is_owner on the earliest user per group, only if that group has no owner yet (re-run safe).
WITH first_user AS (
  SELECT DISTINCT ON (group_id) id, group_id
  FROM "User"
  WHERE group_id IS NOT NULL
  ORDER BY group_id, created_at ASC, id ASC
)
UPDATE "User" u
SET is_owner = true
FROM first_user fu
WHERE u.id = fu.id
  AND NOT EXISTS (SELECT 1 FROM "User" o WHERE o.group_id = u.group_id AND o.is_owner = true);

-- Owners are ADMIN (idempotent).
UPDATE "User" SET role = 'ADMIN' WHERE is_owner = true;
