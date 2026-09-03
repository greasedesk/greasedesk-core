-- ADDRESSEE CORRECTIONS: the append-only record of an invoice being re-addressed.
--
-- NULL = never corrected, which is every invoice that exists. Not backfilled to '[]': an empty
-- array would claim "corrected zero times, and we were looking", which is a different statement
-- from "this column did not exist when that document was raised".
--
-- Its own column rather than an entry in `amendments`, which fires only when the TOTAL moves. An
-- addressee correction never changes a figure, so it would have been invisible there.

ALTER TABLE "Invoice" ADD COLUMN "addressee_corrections" JSONB;
