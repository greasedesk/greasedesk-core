-- ApplicationFeeRate: what GreaseDesk takes on a card payment a garage collects through us.
--
-- Effective-dated on the CommissionRate model. Rates are superseded by a new forward row, never
-- edited: Payment.fee_rate_id is a frozen link, so amending a rate that has already priced a
-- transaction would rewrite history.

CREATE TABLE "ApplicationFeeRate" (
  "id"              TEXT NOT NULL,
  "group_id"        TEXT,
  "country_code"    TEXT NOT NULL,
  "currency"        TEXT NOT NULL,
  "basis_points"    INTEGER NOT NULL,
  "min_fee_pennies" INTEGER,
  "cap_fee_pennies" INTEGER,
  "effective_from"  TIMESTAMP(3) NOT NULL,
  "created_by"      TEXT,
  "created_at"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ApplicationFeeRate_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ApplicationFeeRate_country_code_currency_effective_from_idx"
  ON "ApplicationFeeRate"("country_code", "currency", "effective_from");
CREATE INDEX "ApplicationFeeRate_group_id_idx" ON "ApplicationFeeRate"("group_id");

-- ── THE TIMELINE INVARIANT, AND WHY IT TAKES TWO PARTIAL INDEXES ────────────────────────────────
-- A plain UNIQUE(group_id, country_code, currency, effective_from) does NOT hold here. Postgres
-- treats NULLs as distinct, so it would allow two PLATFORM DEFAULT rows sharing a boundary date and
-- leave the resolver silently picking one of them. Split into the two cases so exactly one row can
-- win on any given date, in either scope.
CREATE UNIQUE INDEX "ApplicationFeeRate_platform_timeline_key"
  ON "ApplicationFeeRate"("country_code", "currency", "effective_from")
  WHERE "group_id" IS NULL;

CREATE UNIQUE INDEX "ApplicationFeeRate_tenant_timeline_key"
  ON "ApplicationFeeRate"("group_id", "country_code", "currency", "effective_from")
  WHERE "group_id" IS NOT NULL;

ALTER TABLE "ApplicationFeeRate"
  ADD CONSTRAINT "ApplicationFeeRate_group_id_fkey"
  FOREIGN KEY ("group_id") REFERENCES "Group"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- NO ROW IS SEEDED. lib/application-fee refuses to invent a rate, exactly as lib/commission does,
-- so an unseeded environment cannot quietly charge zero — it cannot charge at all. The GB/GBP
-- default is set deliberately once the VAT treatment is settled, because that answer decides
-- whether 25 basis points is the right number or whether it should be 30.
