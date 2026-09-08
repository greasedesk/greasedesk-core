-- ONE AMOUNT: £30 OR HELD.
--
-- Hand-written, applied with `migrate deploy`. `migrate dev` proposes a RESET here.
--
-- ── THE REDUCED RATE IS DROPPED, NOT NULLED ────────────────────────────────────────────────────
-- amount_unvisited_pennies held £12.50 for a garage-month whose visit did not happen. There is no
-- £12.50: a month is paid at £30 or it is HELD, and a held month is a decision an area manager
-- makes rather than a smaller number somebody is paid without being asked.
--
-- NULLING IT WOULD HAVE BEEN A LIE. NULL on that column already meant "this row predates the visit
-- gate" — true of the three GB/GBP rows written before 2026-09-06. Nulling the row written FOR the
-- gate would have made it claim to predate itself.
--
-- DROPPING IS SAFE ONLY BECAUSE CommissionEntry HAS ZERO ROWS. rate_id is frozen onto every entry,
-- so with entries present this would remove context from money already booked. There are none, so
-- there is no history to protect. That window closes at the first accrual and does not reopen.
ALTER TABLE "CommissionRate" DROP COLUMN "amount_unvisited_pennies";

-- ── THE ENTRY COLUMN NOW DESCRIBES THE DECISION, NOT THE BRANCH ────────────────────────────────
-- `visited` recorded which of two amounts was used. One amount, so that meaning is gone. The
-- column survives because the release asks a question of the same shape: what picture was the
-- manager shown? Frozen rather than derived — an operator-recorded visit can be added afterwards,
-- and re-deriving would show a different picture than the one they decided on.
--
-- A RENAME, not a drop-and-add: the column keeps its type and its nullability, and there are no
-- rows either way. Its NULL is re-stated in the schema — "this entry has not been released" —
-- because the old sentence ("no visit decision was applied") described a gate that no longer exists.
ALTER TABLE "CommissionEntry" RENAME COLUMN "visited" TO "shown_as_visited";
