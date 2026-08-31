-- TMBS's two Overhead rows are retired: the dashboard now reads Cost/CostInstance, and the owner
-- is re-entering them there with the dates the old register could not hold.
--
-- BY GROUP ID ONLY, and deliberately not a table-wide delete. Three other tenants still have
-- Overhead rows and would have lost them as a side effect of this change:
--   GB-GD2236 Marketbridge  6 rows — the frozen sales demo, under an active presentation hold
--   GB-GD2369 Kingsford     6 rows — calibrated demo generation inputs, not incidental data
--   GB-GD2237 Hugh's Garage 1 row
-- Retiring the Overhead table itself is a separate decision, made on purpose rather than inherited
-- from this migration.
--
-- The allocations go first: CostAllocation has no cascade FROM Overhead in this direction that we
-- should rely on for a data migration, and an orphaned allocation is a cost apportioned to nothing.
DELETE FROM "CostAllocation"
 WHERE "overhead_id" IN (SELECT "id" FROM "Overhead" WHERE "group_id" = '854d38e7-6dd4-4836-af61-a0d169639a78');

DELETE FROM "Overhead" WHERE "group_id" = '854d38e7-6dd4-4836-af61-a0d169639a78';

-- SIDE EFFECT, STATED: lib/setup-signals counts Overhead rows for the `overheads` setup signal, so
-- TMBS's checklist item flips from `done` back to `todo`. It is `gated: false`, so nothing locks —
-- the checklist simply asks for what the owner is about to enter.
