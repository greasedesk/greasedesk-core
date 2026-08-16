-- JobCardPhoto.r2_key becomes NOT NULL.
--
-- The companion to 20260817140000 (group_id). That one was a deletion guarantee — an object
-- outside its tenant partition survives a purge that reports success. This one is narrower: a
-- photo row with no key names an object nothing can reach. Not a leak; an orphan that no reader
-- can render and no operator can locate.
--
-- lib/r2::photoKey is the only builder, and it now REFUSES rather than returning an unusable key,
-- so a null here could only ever mean a caller forgot. 0 of 63 rows were ever null.
--
-- NO DEFAULT: a default key would be worse than a null, because it would point somewhere.

-- It REFUSES; it does not delete. A photo row is a RECORD — who uploaded it, when, at which
-- stage — and a migration must never quietly destroy records to make a constraint fit. Zero rows
-- match here (verified 0 of 63), so this is a no-op on this database; on any other it stops and
-- says how many, and a person decides. The first draft of this file said DELETE. That was wrong
-- for the same reason `?? null` is wrong: it turns a situation nobody understood into a silent
-- outcome.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "JobCardPhoto" WHERE "r2_key" IS NULL) THEN
    RAISE EXCEPTION
      'REFUSING: % JobCardPhoto row(s) have no r2_key. Decide what to do with them; a migration will not delete photo records.',
      (SELECT count(*) FROM "JobCardPhoto" WHERE "r2_key" IS NULL);
  END IF;
END $$;

ALTER TABLE "JobCardPhoto" ALTER COLUMN "r2_key" SET NOT NULL;
