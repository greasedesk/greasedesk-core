-- THE GARAGE'S OWN STRIPE ACCOUNT (Standard connected account).
--
-- All nullable / defaulted false: every existing tenant reads "not connected", which is true. No
-- backfill, nothing to infer. Kept off GroupBilling on purpose — that table is GreaseDesk's own
-- subscription and its webhook already writes it.
ALTER TABLE "Group" ADD COLUMN "stripe_account_id"       TEXT;
ALTER TABLE "Group" ADD COLUMN "stripe_charges_enabled"  BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Group" ADD COLUMN "stripe_payouts_enabled"  BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Group" ADD COLUMN "stripe_disabled_reason"  TEXT;
ALTER TABLE "Group" ADD COLUMN "stripe_requirements_due" JSONB;
ALTER TABLE "Group" ADD COLUMN "stripe_connected_at"     TIMESTAMP(3);
ALTER TABLE "Group" ADD COLUMN "stripe_disconnected_at"  TIMESTAMP(3);
CREATE UNIQUE INDEX "Group_stripe_account_id_key" ON "Group"("stripe_account_id");
