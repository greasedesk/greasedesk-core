-- Webhook idempotency ledger (item-12).
CREATE TABLE "StripeEvent" (
  "event_id" TEXT NOT NULL,
  "type" TEXT NOT NULL,
  "processed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "StripeEvent_pkey" PRIMARY KEY ("event_id")
);
