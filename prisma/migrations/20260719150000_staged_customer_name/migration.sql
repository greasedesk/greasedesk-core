-- Customer name parsed from the invoice block, then editable in the wizard.
-- Staging only; additive.
ALTER TABLE "StagedInvoice" ADD COLUMN "customer_name" TEXT;
