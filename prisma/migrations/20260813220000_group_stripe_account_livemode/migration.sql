-- WHICH MODE A CONNECTED ACCOUNT LIVES IN, recorded rather than inferred.
--
-- Test and live account ids are both `acct_…` and indistinguishable; the platform key cannot be
-- trusted to say which, because production runs a restricted live key that fails a prefix test.
-- Nullable: unknown for anything created before this column. No rows are connected today, so there
-- is nothing to backfill and nothing to guess.
ALTER TABLE "Group" ADD COLUMN "stripe_account_livemode" BOOLEAN;
