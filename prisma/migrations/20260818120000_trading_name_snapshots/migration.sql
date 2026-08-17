-- Freeze the TRADING name onto the documents that show it.
--
-- Group.trading_name already existed and was already read by the SMS, the quote document and the
-- quote-respond email — it was simply never editable, so it is NULL for every real tenant and every
-- reader falls through to the registered name. Making it editable (this slice) means it will start
-- appearing on customer-facing surfaces, and the moment it does, an INVOICE that renders it must
-- render the name as it stood AT ISSUE.
--
-- Otherwise a garage that rebrands makes every historical invoice reprint under the new name, and
-- the invoice stops being a record of what the customer received. That is the freeze-at-issue rule
-- the whole invoice model rests on, and the same failure shape as a labour rate revaluing a closed
-- month.
--
-- ON CreditNote TOO, deliberately, BEFORE it has issued a single document. Retrofitting a snapshot
-- onto documents already in customers' hands is not possible; adding it while the table is empty
-- costs nothing.
--
-- NULLABLE, AND THE NULL IS TEMPORAL: rows issued before this column existed genuinely carried no
-- trading name. The renderer falls back to company_name_snapshot for them, which is honest. It is
-- NOT the "a caller forgot" shape — the mint writes it on every new document from here.
-- No backfill: inventing a trading name for a historical document would be asserting something
-- about the past that nobody recorded.

ALTER TABLE "Invoice"    ADD COLUMN "company_trading_name_snapshot" TEXT;
ALTER TABLE "CreditNote" ADD COLUMN "company_trading_name_snapshot" TEXT;
