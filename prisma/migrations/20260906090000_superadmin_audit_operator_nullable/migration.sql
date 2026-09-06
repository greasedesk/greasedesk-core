-- SuperAdminAudit.operator_user_id becomes nullable.
--
-- NULL means NO OPERATOR ACTED: the platform reconciled something by itself. Today that is the
-- Stripe cache writer clearing a free decision that a live subscription has overtaken — a real
-- record whose author is not a person. The alternative was a sentinel operator id, which would be
-- a lie in the one table whose job is saying who did what.
--
-- Widening only: every existing row keeps its value, and no read can break on a column that was
-- previously always present. Every operator-initiated action still sets it.
ALTER TABLE "SuperAdminAudit" ALTER COLUMN "operator_user_id" DROP NOT NULL;
