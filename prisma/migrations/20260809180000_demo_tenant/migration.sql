-- Demo tenants. Additive: three columns, one defaulted, two nullable. No rewrite.
-- is_demo is the safety flag (blocks sends, passes the onboarding gate, excluded from counts).
-- demo_expires_at NULL = never expires (the long-lived sales demo).
ALTER TABLE "Group" ADD COLUMN "is_demo" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Group" ADD COLUMN "demo_expires_at" TIMESTAMP(3);
ALTER TABLE "Group" ADD COLUMN "demo_seed" TEXT;
