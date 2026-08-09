-- Additive and nullable throughout. No backfill: an existing verified number was confirmed by SMS,
-- so phone_recorded_at is set from phone_verified_at where one exists — those ARE recorded, and
-- leaving them null would gate a tenant who has already proved a handset.
ALTER TABLE "TwoFactorSecret" ADD COLUMN "phone_recorded_at" TIMESTAMP(3);
ALTER TABLE "TwoFactorSecret" ADD COLUMN "phone_confirmed_via" TEXT;
UPDATE "TwoFactorSecret"
   SET "phone_recorded_at" = "phone_verified_at", "phone_confirmed_via" = 'sms'
 WHERE "phone_verified_at" IS NOT NULL;

ALTER TABLE "Group" ADD COLUMN "phone_step_exempt_at" TIMESTAMP(3);
ALTER TABLE "Group" ADD COLUMN "phone_step_exempt_reason" TEXT;
ALTER TABLE "Group" ADD COLUMN "phone_step_exempt_by" TEXT;
