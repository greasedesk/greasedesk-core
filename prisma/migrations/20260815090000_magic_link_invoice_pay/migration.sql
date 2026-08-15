-- invoice_pay magic links: a link bound to ONE FROZEN INVOICE rather than to the job card.
--
-- ADDITIVE. Existing links are untouched: invoice_id is NULL for every quote_view row, which is
-- correct rather than missing — a quote link opens a quote, and has no invoice to name.

ALTER TYPE "MagicLinkPurpose" ADD VALUE IF NOT EXISTS 'invoice_pay';

ALTER TABLE "CustomerMagicLink" ADD COLUMN "invoice_id" TEXT;

CREATE INDEX "CustomerMagicLink_invoice_id_idx" ON "CustomerMagicLink"("invoice_id");

-- CASCADE matches the job_card relation already on this table: if the invoice is deleted the link
-- is meaningless. Note that VOIDING an invoice does NOT delete it — a voided invoice is retained
-- and its link keeps resolving, so the customer sees the retired document rather than a dead URL.
ALTER TABLE "CustomerMagicLink"
  ADD CONSTRAINT "CustomerMagicLink_invoice_id_fkey"
  FOREIGN KEY ("invoice_id") REFERENCES "Invoice"("id") ON DELETE CASCADE ON UPDATE CASCADE;
