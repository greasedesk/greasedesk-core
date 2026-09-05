-- FREE TENANTS: a decision, with an author and a date.
--
-- Both nullable, nothing backfilled. NULL means a normal paying tenant, which is nearly all of
-- them, and it is the honest answer for every row that exists today — nobody has decided anything
-- about them.
--
-- NOT a BillingStatus value. GroupBilling mirrors Stripe's truth and a verified webhook writes it,
-- so "free" there would be a claim about a subscription object that does not exist. That was
-- considered and refused once already in lib/onboarding, for the same reason.

ALTER TABLE "Group" ADD COLUMN "free_since"  TIMESTAMP(3);
ALTER TABLE "Group" ADD COLUMN "free_reason" TEXT;
