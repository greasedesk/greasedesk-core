-- VAT-registration master switch + overhead VAT component. Additive and behaviour-preserving:
-- existing tenants default to registered=true (VAT applies as now); overhead VAT component 0 = no split.
ALTER TABLE "Group"    ADD COLUMN "vat_registered"     BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "Overhead" ADD COLUMN "vat_amount_pennies" INTEGER NOT NULL DEFAULT 0;
