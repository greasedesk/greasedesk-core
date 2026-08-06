-- Additive only, both nullable. NULL on every existing row is CORRECT: it means no grace has begun,
-- which is true of every tenant today. Nothing is backfilled — a tenant only acquires an anchor when
-- a verified webhook says it entered a grace-worthy state.
ALTER TABLE "GroupBilling" ADD COLUMN "grace_started_at" TIMESTAMP(3);
ALTER TABLE "GroupBilling" ADD COLUMN "grace_reason" TEXT;
