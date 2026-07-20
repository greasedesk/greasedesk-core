-- The printed GROSS total, captured at ingest. The parser has always produced it (totalPrinted);
-- only subtotal and VAT were stored, so the post-commit assertion had nothing to check the gross
-- against. Additive and nullable: existing rows keep NULL and the assertion skips what it cannot
-- compare rather than inventing a figure.
ALTER TABLE "StagedInvoice" ADD COLUMN "total_printed" DECIMAL(12,2);
