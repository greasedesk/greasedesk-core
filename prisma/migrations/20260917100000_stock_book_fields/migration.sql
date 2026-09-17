-- @migration: additive
--
-- THE STOCK BOOK'S OWN FIELDS, and the marker for a sale recorded but never invoiced.
--
-- STOCK NUMBER: per tenant, in sequence, from its own counter table. NULL on every car that exists
-- today, meaning "taken in before stock numbers existed" — the book says so rather than inventing one.
-- No UNIQUE index yet: CREATE UNIQUE INDEX classifies constraining. The counter is the guarantee until
-- an index follows in a migration of its own.
--
-- SELLER, PURCHASE REF, RECEIPT REF, BUYER: nullable, and a NULL has two meanings that
-- not_on_paperwork tells apart — "looked and it was not there" versus "nobody was asked". Both default
-- to an empty list, which is the truth about every row that exists: nobody has stated anything missing.
--
-- recorded_not_invoiced: FALSE on every disposal, which is correct — every disposal so far came through
-- the paths that either mint (a sale) or are not sales. Only lib/stock-historical writes TRUE.
--
-- buyer_customer_id has NO foreign key, like stock_disposal_id: ADD CONSTRAINT would cost a push.
ALTER TABLE "StockDisposal" ADD COLUMN     "buyer_address" TEXT,
ADD COLUMN     "buyer_customer_id" TEXT,
ADD COLUMN     "buyer_name" TEXT,
ADD COLUMN     "not_on_paperwork" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "receipt_ref" TEXT,
ADD COLUMN     "recorded_not_invoiced" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "StockItem" ADD COLUMN     "not_on_paperwork" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "purchase_ref" TEXT,
ADD COLUMN     "seller_name" TEXT,
ADD COLUMN     "stock_number" INTEGER;

CREATE TABLE "StockNumberSequence" (
    "group_id" TEXT NOT NULL,
    "last_value" INTEGER NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "StockNumberSequence_pkey" PRIMARY KEY ("group_id")
);
