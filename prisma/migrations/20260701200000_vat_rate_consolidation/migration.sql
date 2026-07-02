-- VAT rate consolidation: one company default on Group, cascading; overheads move to ex-VAT + rate.

-- 1) Company default VAT rate on Group, seeded from the existing 'UK VAT' TaxRate (else 20).
ALTER TABLE "Group" ADD COLUMN "default_vat_rate" DECIMAL(5,2) NOT NULL DEFAULT 20;
UPDATE "Group" g SET "default_vat_rate" = COALESCE(
  (SELECT t."percentage" FROM "TaxRate" t
     WHERE t."group_id" = g."id" AND t."name" = 'UK VAT'
     ORDER BY t."valid_from" DESC LIMIT 1), 20);

-- 2) Overheads → ex-VAT amount + per-expense rate. Back-calc from the existing gross + stored VAT:
--    ex_vat = gross − vat_amount ; rate = vat_amount / ex_vat × 100 (0 when ex_vat is 0). Exact
--    reconstruction for the standard case; not a silent mis-convert.
ALTER TABLE "Overhead" ADD COLUMN "ex_vat_amount_pennies" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Overhead" ADD COLUMN "vat_rate" DECIMAL(5,2) NOT NULL DEFAULT 0;
UPDATE "Overhead" SET
  "ex_vat_amount_pennies" = "amount_pennies" - "vat_amount_pennies",
  "vat_rate" = CASE WHEN ("amount_pennies" - "vat_amount_pennies") > 0
    THEN ROUND("vat_amount_pennies"::numeric / ("amount_pennies" - "vat_amount_pennies")::numeric * 100, 2)
    ELSE 0 END;
ALTER TABLE "Overhead" DROP COLUMN "amount_pennies";
ALTER TABLE "Overhead" DROP COLUMN "vat_amount_pennies";
