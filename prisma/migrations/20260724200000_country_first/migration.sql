-- Country-first onboarding: country of record + coming-soon waitlist.
ALTER TABLE "Group" ADD COLUMN "country_code" TEXT;

-- Existing tenants have a tax_country_code already (default GB) — backfill country_code from it so
-- they stay onboarded (the new country step's completion signal is country_code being non-null).
UPDATE "Group" SET "country_code" = COALESCE("tax_country_code", 'GB') WHERE "country_code" IS NULL;

CREATE TABLE "CountryWaitlist" (
    "id"           TEXT NOT NULL,
    "email"        TEXT NOT NULL,
    "country_code" TEXT NOT NULL,
    "group_id"     TEXT,
    "created_at"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CountryWaitlist_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "CountryWaitlist_country_code_created_at_idx" ON "CountryWaitlist"("country_code", "created_at");
ALTER TABLE "CountryWaitlist" ADD CONSTRAINT "CountryWaitlist_group_id_fkey"
    FOREIGN KEY ("group_id") REFERENCES "Group"("id") ON DELETE SET NULL ON UPDATE CASCADE;
