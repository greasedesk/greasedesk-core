-- @migration: additive
--
-- FREEZE THE GARAGE'S FIRST-YEAR OFFER AT SIGNUP (owner ruling, 2026-10-29).
--
-- TenantAffiliateTerms froze what the AFFILIATE earns and nothing about what the GARAGE gets. The
-- Engine Room tells the operator an offer change "applies to garages signing up from now on only";
-- that was true of the reward and false of the discount. Changing offer_months_paid re-priced the
-- first year of every referred garage that had not yet paid. Observed, not theorised: GB-GD2907 was
-- referred while the setting read 6 and its screen moved from £450 to £600 eleven minutes later,
-- mid-rehearsal.
--
-- NULLABLE AND NOT BACKFILLED. A row written before this column has no honest value to give: the
-- setting in force at its signup is recorded nowhere. offerFor falls back to the live setting for
-- those rows, which is exactly the behaviour they have had since they were written.
--
-- THE RENEWAL MONTHS ARE NOT FROZEN, by the same ruling. £750 is the list price, read at checkout;
-- once a garage subscribes, Stripe holds the amount. Freezing it before anyone subscribes would
-- promise "£750 a year for ever" to everyone who ever followed a referral link.

ALTER TABLE "TenantAffiliateTerms" ADD COLUMN "offer_months_paid" INTEGER;
ALTER TABLE "TenantAffiliateTerms" ADD COLUMN "months_given" INTEGER;
