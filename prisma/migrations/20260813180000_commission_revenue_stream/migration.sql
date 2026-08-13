-- WHICH REVENUE A COMMISSION RATE PRICES, AND WHICH PRODUCED AN ENTRY.
--
-- Defaulted to 'subscription', which is what every existing row is: a flat sum per collected month
-- of the £75 platform subscription. Nothing else exists yet and nothing changes today.
--
-- Added ahead of need. Application fees on garage card takings would be a second stream shaped
-- differently — a share of a variable amount per transaction — and CommissionEntry.rate_id is a
-- frozen link to the rate applied, so every historic entry is anchored to a rate that never
-- contemplated one. This column now is free; the same column after a year of live entries is a
-- migration over frozen money.
ALTER TABLE "CommissionRate"  ADD COLUMN "revenue_stream" TEXT NOT NULL DEFAULT 'subscription';
ALTER TABLE "CommissionEntry" ADD COLUMN "revenue_stream" TEXT NOT NULL DEFAULT 'subscription';

-- The rate timeline is per stream as well as per key.
DROP INDEX IF EXISTS "CommissionRate_country_code_currency_tier_effective_from_key";
CREATE UNIQUE INDEX "CommissionRate_revenue_stream_country_code_currency_tier_ef_key"
  ON "CommissionRate"("revenue_stream", "country_code", "currency", "tier", "effective_from");
