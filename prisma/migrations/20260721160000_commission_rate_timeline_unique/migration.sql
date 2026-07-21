-- CommissionRate: enforce a clean, non-overlapping effective-dated timeline per key.
-- For a (country_code, currency, tier), the effective_from boundary point must be unique — two rows
-- on the same boundary would make the engine's "latest effective_from ≤ collected_at" lookup
-- ambiguous. The UNIQUE index replaces the old non-unique index (same leading columns, so it still
-- serves resolveRate). Rate amendments are NEW forward-dated rows on distinct boundary days; this
-- constraint refuses a colliding boundary, never a legitimate amendment.
DROP INDEX "CommissionRate_country_code_currency_tier_effective_from_idx";
CREATE UNIQUE INDEX "CommissionRate_country_code_currency_tier_effective_from_key" ON "CommissionRate"("country_code", "currency", "tier", "effective_from");
