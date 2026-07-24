-- Slice 1 C: module entitlement. Additive — GroupFeature gains provenance + a timestamp.
CREATE TYPE "FeatureSource" AS ENUM ('stripe', 'grant', 'default');

ALTER TABLE "GroupFeature" ADD COLUMN "source" "FeatureSource" NOT NULL DEFAULT 'stripe';
ALTER TABLE "GroupFeature" ADD COLUMN "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- Every EXISTING tenant keeps everything: seed all modules enabled, marked as the pre-sale default.
-- Idempotent (ON CONFLICT), so re-running the migration cannot double-insert or flip a real grant.
INSERT INTO "GroupFeature" ("id", "group_id", "feature_key", "enabled", "source", "updated_at")
SELECT gen_random_uuid()::text, g."id", m."key", true, 'default', CURRENT_TIMESTAMP
FROM "Group" g
CROSS JOIN (VALUES ('core'), ('booking'), ('promos')) AS m("key")
ON CONFLICT ("group_id", "feature_key") DO NOTHING;
