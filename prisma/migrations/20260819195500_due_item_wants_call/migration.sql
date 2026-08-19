-- "Ring me about it" is a real answer and none of the other three hold it: not not_raised (they
-- WERE asked), not declined (no), not agreed_later (not yes). Additive, and its own migration
-- because ALTER TYPE ... ADD VALUE is a different kind of change from creating a table.
ALTER TYPE "DueItemResponse" ADD VALUE 'wants_call';
