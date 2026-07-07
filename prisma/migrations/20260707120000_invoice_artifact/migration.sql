-- Invoice artifact: warranty series + FY display config + email footer. Additive; the unique-key
-- swap on Invoice is safe (all existing rows default to series='chargeable' — and prod has none).

CREATE TYPE "InvoiceSeries" AS ENUM ('chargeable', 'warranty');

ALTER TABLE "Invoice" ADD COLUMN "series" "InvoiceSeries" NOT NULL DEFAULT 'chargeable';
ALTER TABLE "Invoice" DROP CONSTRAINT IF EXISTS "Invoice_group_id_sequence_value_key";
DROP INDEX IF EXISTS "Invoice_group_id_sequence_value_key";
CREATE UNIQUE INDEX "Invoice_group_id_series_sequence_value_key" ON "Invoice"("group_id", "series", "sequence_value");

ALTER TABLE "InvoiceSequence" ADD COLUMN "warranty_last_value" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "Group" ADD COLUMN "invoice_fy_digits" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Group" ADD COLUMN "fy_start_month" INTEGER NOT NULL DEFAULT 4;
ALTER TABLE "Group" ADD COLUMN "invoice_warranty_prefix" TEXT NOT NULL DEFAULT 'W';
ALTER TABLE "Group" ADD COLUMN "invoice_email_footer" BOOLEAN NOT NULL DEFAULT true;
