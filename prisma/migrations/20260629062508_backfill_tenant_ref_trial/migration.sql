-- Data backfill + finalise (committed, idempotent).
-- 1) Sequential refs for existing tenants, deterministic by created_at.
WITH ordered AS (
  SELECT id, ROW_NUMBER() OVER (ORDER BY created_at ASC, id ASC) - 1 AS rn
  FROM "Group" WHERE ref IS NULL
)
UPDATE "Group" g SET ref = 'GB-GD' || (1965 + o.rn)::text
FROM ordered o WHERE g.id = o.id;

-- 2) Start every existing tenant's 60-day trial from today (only if unset).
UPDATE "Group" SET trial_ends_at = now() + interval '60 days' WHERE trial_ends_at IS NULL;

-- 3) Sync the sequence to continue after the highest assigned ref.
SELECT setval('group_ref_seq', (SELECT COALESCE(MAX(substring(ref from 6)::int), 1964) FROM "Group" WHERE ref LIKE 'GB-GD%'));

-- 4) Lock ref: required + auto-assigned from the sequence on every future insert.
ALTER TABLE "Group" ALTER COLUMN "ref" SET NOT NULL;
ALTER TABLE "Group" ALTER COLUMN "ref" SET DEFAULT ('GB-GD' || nextval('group_ref_seq'));
