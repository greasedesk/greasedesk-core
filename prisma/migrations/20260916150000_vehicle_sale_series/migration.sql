-- @migration: additive
--
-- A FOURTH invoice series, for the sale of a car out of stock, plus the VAT treatment the resulting
-- document carries.
--
-- ADDITIVE ONLY, no renames — `prisma migrate deploy` runs during the build while the previous
-- deployment is still serving. ALTER TYPE ... ADD VALUE is safe here for the same reason it was when
-- 'historical' was added (20260803190000): nothing in this migration USES the new value, and nothing
-- can write it until the code that mints it is deployed. A deployed reader only meets the value once
-- a row carries it, so no vehicle_sale invoice may be minted against this database before that push.
--
-- The counter is separate from the other three for the reason the third one exists: a car sale must
-- never advance the chargeable counter, and each series stays independently gapless.
ALTER TYPE "InvoiceSeries" ADD VALUE 'vehicle_sale';

ALTER TABLE "InvoiceSequence" ADD COLUMN "vehicle_sale_last_value" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "Group" ADD COLUMN "invoice_vehicle_sale_prefix" TEXT NOT NULL DEFAULT 'VS';

-- WHICH VAT TREATMENT THIS DOCUMENT CARRIES, frozen at issue like every other snapshot on the row:
-- margin | qualifying | none | unsettled (lib/stock::VatPosition). TEXT rather than a second enum,
-- deliberately — a pg_enum and a TypeScript union drifting apart has already cost a 500 here, and a
-- text column with the union as the single authority cannot drift in that direction.
-- NULL on every garage invoice, which is all of them today.
ALTER TABLE "Invoice" ADD COLUMN "vat_position" TEXT;
