-- Item-12 subscription billing. Additive + one enum-value rename.
-- P2: 'suspended' → 'lapsed' (the read-only-forever guarantee, legible in the enum).
ALTER TYPE "BillingStatus" RENAME VALUE 'suspended' TO 'lapsed';

-- Stripe cache (webhook-written only) — GroupBilling gains exactly four fields.
ALTER TABLE "GroupBilling" ADD COLUMN "stripe_customer_id" TEXT;
ALTER TABLE "GroupBilling" ADD COLUMN "stripe_subscription_id" TEXT;
ALTER TABLE "GroupBilling" ADD COLUMN "subscription_status" TEXT;
ALTER TABLE "GroupBilling" ADD COLUMN "current_period_end" TIMESTAMP(3);
CREATE UNIQUE INDEX "GroupBilling_stripe_customer_id_key" ON "GroupBilling"("stripe_customer_id");
CREATE UNIQUE INDEX "GroupBilling_stripe_subscription_id_key" ON "GroupBilling"("stripe_subscription_id");
