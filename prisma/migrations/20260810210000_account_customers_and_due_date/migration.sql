-- ACCOUNT CUSTOMERS AND THE DUE DATE.
--
-- Every column is nullable and nothing is backfilled, on purpose: NULL is not "missing", it is the
-- statement the product has always made. A customer with no terms pays on collection, and an
-- invoice with no due date cannot be overdue — which is exactly true of every row that exists
-- today. So this migration changes no behaviour at all until somebody sets terms on a customer.
--
-- Backfilling a default of 30 days would have retroactively put the entire back catalogue on terms
-- and made a year of settled retail work look like a debtor book.
ALTER TABLE "Customer" ADD COLUMN "account_terms_days" INTEGER;
ALTER TABLE "Customer" ADD COLUMN "account_name" TEXT;
ALTER TABLE "Invoice"  ADD COLUMN "due_date" TIMESTAMP(3);

-- The overdue read is (status='issued' AND due_date < now), always tenant-scoped. Partial, because
-- the overwhelming majority of invoices are retail with a NULL due date and have no business
-- occupying an index that exists to answer "who is late".
CREATE INDEX "Invoice_group_id_due_date_idx" ON "Invoice"("group_id", "due_date") WHERE "due_date" IS NOT NULL;
