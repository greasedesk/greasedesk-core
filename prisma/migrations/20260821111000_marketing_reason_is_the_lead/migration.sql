-- `reason` SAYS WHAT THE CALL WAS ABOUT, in the board's own vocabulary.
--
-- The enum was `mot | service` — the names of the two lists the board used to be. With the lists
-- gone it could only ever record which tab a row came from, and since every row now comes from the
-- same place it recorded 'mot' for a car rung about a failed battery.
--
-- The lead's strongest reason is the honest value, and it already exists: LeadReasonKind in
-- lib/marketing-pipeline. TEXT with a CHECK rather than a Postgres enum, because this set will grow
-- as signals are added and a migration per value is friction that leads to somebody reusing an
-- ill-fitting one. The CHECK still refuses a typo.
--
-- Zero rows exist, so no mapping is required and none is invented.
ALTER TABLE "MarketingContact" ALTER COLUMN "reason" TYPE TEXT USING "reason"::TEXT;
DROP TYPE IF EXISTS "MarketingReason";

ALTER TABLE "MarketingContact" ADD CONSTRAINT "MarketingContact_reason_check"
  CHECK ("reason" IN (
    'mot_expired', 'battery_replace', 'tyre_illegal', 'agreed_not_booked',
    'mot_due', 'service_due', 'unanswered', 'battery_retest',
    'declined', 'snoozed', 'distant'
  ));
