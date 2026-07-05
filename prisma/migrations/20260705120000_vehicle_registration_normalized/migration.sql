-- Canonical registration match key (mirrors vin_normalized). Additive + backfill existing rows so
-- retroactive matching works (upper-case, strip everything non-alphanumeric).
ALTER TABLE "Vehicle" ADD COLUMN "registration_normalized" TEXT;

UPDATE "Vehicle"
SET "registration_normalized" = NULLIF(regexp_replace(upper("registration"), '[^A-Z0-9]', '', 'g'), '');

CREATE INDEX "Vehicle_group_id_registration_normalized_idx" ON "Vehicle"("group_id", "registration_normalized");
