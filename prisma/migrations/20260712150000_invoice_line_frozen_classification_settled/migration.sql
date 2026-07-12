-- Freeze-at-issue prerequisites (additive):
-- 1) InvoiceLine gains the frozen classification the ledger reads (item_type, labour_outsourced).
--    item_type nullable ONLY for pre-backfill legacy rows; every new snapshot writes both.
-- 2) InvoiceStatus gains 'settled' — the warranty terminal state (£0, closed at issue, never AR).
ALTER TYPE "InvoiceStatus" ADD VALUE IF NOT EXISTS 'settled';

ALTER TABLE "InvoiceLine" ADD COLUMN "item_type" "ItemType";
ALTER TABLE "InvoiceLine" ADD COLUMN "labour_outsourced" BOOLEAN NOT NULL DEFAULT false;
