-- Drop JobCard.labour_bill_numeric and parts_bill_numeric, now that WIP derives from the lines.
--
-- Deliberately a SEPARATE step from the derivation (19921e3): the derivation had to be proven on
-- the served app first — tile and list both reading 10 cards / £6,338.00 — because dropping the
-- fallback and changing the source in one commit leaves nothing to compare against if the figure
-- moves unexpectedly.
--
-- These were a denormalisation with EXACTLY ONE WRITER (jobcard-quote, on save). A denormalised
-- figure diverges the moment anything creates the underlying rows by another route, and fixtures
-- are the most common other route. It had already happened: four ZZ cards each carrying a £980
-- line while these columns read 0/0 — £3,920 of open work invisible to the WIP tile. Across the
-- whole table 34 of 1,673 cards disagreed with their own lines.
--
-- A cache will agree with its source on the day you test it. That is the property that makes it
-- dangerous, not safe. Removed rather than left unread, for the same reason the two COST numerics
-- were removed in 20260817180000: a stale column is what a future question reaches for and trusts.

ALTER TABLE "JobCard" DROP COLUMN "labour_bill_numeric";
ALTER TABLE "JobCard" DROP COLUMN "parts_bill_numeric";
