-- JobCardPhoto.group_id becomes NOT NULL — a DELETION GUARANTEE, not tidiness.
--
-- group_id is the tenant partition AND the first segment of the R2 object key. The SuperAdmin
-- purge deletes objects by the prefix `{group_id}/` (lib/r2::deleteByPrefix, via tenantPrefix).
-- A photo written without a tenant lands at the BUCKET ROOT — outside every partition — so it is
-- not in the purge's scope and the purge reports success while leaving the data behind. If a
-- garage exercised an erasure request we would have told them their data was destroyed and it
-- would not have been.
--
-- Closed by convention until now: all three writers (photos/index, presign, multipart) carry the
-- tenant guard, and 0 of 63 rows are null. Closed by convention is not the same as closed.
--
-- The other half of the fix is in lib/r2::photoKey, which now THROWS rather than yielding an empty
-- first segment. A function that silently produces a rootward path when handed nothing is the same
-- shape as `?? null`.

-- No rows to backfill (verified: 0 of 63 null). The statement is here so the migration is correct
-- against any database, not just this one.
UPDATE "JobCardPhoto" p
   SET "group_id" = c."group_id"
  FROM "JobCard" c
 WHERE p."job_card_id" = c."id"
   AND p."group_id" IS NULL;

-- NO DEFAULT. Same rule as Payment.site_id and Refund.collected_at: a default lets the next
-- forgetful caller write a plausible wrong value instead of failing.
ALTER TABLE "JobCardPhoto" ALTER COLUMN "group_id" SET NOT NULL;
