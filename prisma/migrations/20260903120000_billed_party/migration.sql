-- BILLED PARTY: who the invoice is addressed to, when that is not the person whose car it is.
--
-- All five columns are NULLABLE and NOTHING IS BACKFILLED. NULL means "billed to the customer",
-- which is the truth for every one of the existing documents and for nearly every one raised
-- since. Writing '' would claim "billed to an account with no name", which is a different and
-- untrue statement about 3,395 invoices.
--
-- The address is a column of its own rather than a fallback. When a garage sets an account name
-- and no account address the document prints NO address, because the only other candidate is the
-- customer's home address under the company's name.

ALTER TABLE "Customer"   ADD COLUMN "account_address" TEXT;

ALTER TABLE "Invoice"    ADD COLUMN "account_name_snapshot" TEXT;
ALTER TABLE "Invoice"    ADD COLUMN "account_address_snapshot" TEXT;

ALTER TABLE "CreditNote" ADD COLUMN "account_name_snapshot" TEXT;
ALTER TABLE "CreditNote" ADD COLUMN "account_address_snapshot" TEXT;
