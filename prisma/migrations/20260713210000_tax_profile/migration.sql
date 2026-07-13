-- TaxProfile groundwork (item-13). Additive: new nullable/defaulted columns on Group. No data
-- moved, no column dropped — default_vat_rate stays as the legacy Decimal source until the
-- guarded rate-bp backfill lands. tax_default_rate_bp NULL = "derive from default_vat_rate ×100".
ALTER TABLE "Group" ADD COLUMN "tax_country_code" TEXT NOT NULL DEFAULT 'GB';
ALTER TABLE "Group" ADD COLUMN "tax_model" TEXT NOT NULL DEFAULT 'vat';
ALTER TABLE "Group" ADD COLUMN "tax_default_rate_bp" INTEGER;
ALTER TABLE "Group" ADD COLUMN "prices_include_tax" BOOLEAN NOT NULL DEFAULT false;
