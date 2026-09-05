-- The addressee correction mechanism is retired. Unlocking makes a document PROVISIONAL, so a
-- re-issue rebuilds the party and the car from the customer record; re-addressing an unpaid invoice
-- is now "edit the customer, press re-issue" and there is no second path to the same four columns.
--
-- SAFE TO DROP RATHER THAN KEEP: the column was live for one day and holds no rows in any tenant
-- (0 invoices with a correction, 0 with an account addressee, checked immediately before this).
-- A never-written log left in place is a nullable column that can only ever be null, and every
-- reader of it would be dead code.
--
-- The AuditLog rows for invoice.addressee_corrected are NOT touched. They record acts that really
-- happened (gate fixtures, on ZZ), and audit rows are never deleted.

ALTER TABLE "Invoice" DROP COLUMN "addressee_corrections";
