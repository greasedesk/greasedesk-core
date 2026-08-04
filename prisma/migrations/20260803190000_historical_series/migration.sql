-- A third invoice series for records of invoices issued under a previous system.
-- ADDITIVE ONLY, no renames — `prisma migrate deploy` runs during the build while the previous
-- deployment is still serving. ALTER TYPE ... ADD VALUE is safe here because nothing in this
-- migration USES the new value.
ALTER TYPE "InvoiceSeries" ADD VALUE 'historical';

ALTER TABLE "InvoiceSequence" ADD COLUMN "historical_last_value" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Group" ADD COLUMN "invoice_historical_prefix" TEXT NOT NULL DEFAULT 'H';
