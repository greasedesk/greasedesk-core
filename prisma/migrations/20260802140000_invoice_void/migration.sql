-- Void an invoice issued in error, retaining the document (VATREC5010).
-- ADDITIVE ONLY. No renames — the same reason the leaving slice left `end_date` in place:
-- `prisma migrate deploy` runs during the build while the PREVIOUS deployment is still serving,
-- so a rename would throw on live reads for the minutes until the new build is promoted.
--
-- ALTER TYPE ... ADD VALUE is safe inside this transaction on PG12+ because nothing in this
-- migration USES the new value; the first write of it happens in a later request.
ALTER TYPE "InvoiceStatus" ADD VALUE 'void';

ALTER TABLE "Invoice" ADD COLUMN "voided_at" TIMESTAMP(3);
ALTER TABLE "Invoice" ADD COLUMN "voided_by" TEXT;
ALTER TABLE "Invoice" ADD COLUMN "void_category" TEXT;
ALTER TABLE "Invoice" ADD COLUMN "void_reason" TEXT;
