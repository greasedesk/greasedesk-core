-- BATTERY TEST CAPTURE. Additive: one enum, one table, no existing column touched.

CREATE TYPE "CcaStandard" AS ENUM ('EN', 'SAE', 'DIN', 'JIS', 'IEC');

CREATE TABLE "BatteryReading" (
    "id"           TEXT NOT NULL,
    "group_id"     TEXT NOT NULL,
    "vehicle_id"   TEXT NOT NULL,
    "job_card_id"  TEXT,
    "voltage_mv"   INTEGER NOT NULL,
    "soc_pct"      INTEGER NOT NULL,
    "soh_pct"      INTEGER NOT NULL,
    "rated_cca"    INTEGER,
    "cca_standard" "CcaStandard",
    "measured_at"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "measured_by"  TEXT,

    CONSTRAINT "BatteryReading_pkey" PRIMARY KEY ("id")
);

-- A rated CCA is only meaningful WITH its standard: EN, SAE and DIN rate the same battery
-- differently, and the health percentage is computed against that rating. Half a denominator is
-- worse than none, because it looks comparable and is not. Both, or neither.
ALTER TABLE "BatteryReading"
  ADD CONSTRAINT "BatteryReading_rating_paired"
  CHECK (("rated_cca" IS NULL) = ("cca_standard" IS NULL));

-- Percentages are percentages and a voltage is not negative. Loud at the boundary rather than
-- plausible in a report.
ALTER TABLE "BatteryReading"
  ADD CONSTRAINT "BatteryReading_bounds"
  CHECK ("soc_pct" BETWEEN 0 AND 100 AND "soh_pct" BETWEEN 0 AND 100 AND "voltage_mv" BETWEEN 0 AND 30000);

-- One test per visit. NULLs are distinct in Postgres, so readings orphaned by a deleted card
-- (job_card_id SetNull) coexist rather than colliding — the same behaviour as TyreReading.
CREATE UNIQUE INDEX "BatteryReading_job_card_id_key" ON "BatteryReading"("job_card_id");
CREATE INDEX "BatteryReading_group_id_vehicle_id_measured_at_idx" ON "BatteryReading"("group_id", "vehicle_id", "measured_at");

ALTER TABLE "BatteryReading" ADD CONSTRAINT "BatteryReading_group_id_fkey"
  FOREIGN KEY ("group_id") REFERENCES "Group"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "BatteryReading" ADD CONSTRAINT "BatteryReading_vehicle_id_fkey"
  FOREIGN KEY ("vehicle_id") REFERENCES "Vehicle"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "BatteryReading" ADD CONSTRAINT "BatteryReading_job_card_id_fkey"
  FOREIGN KEY ("job_card_id") REFERENCES "JobCard"("id") ON DELETE SET NULL ON UPDATE CASCADE;
