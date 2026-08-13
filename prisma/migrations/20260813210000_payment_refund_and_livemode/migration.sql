-- MONEY THAT ARRIVED, MONEY GIVEN BACK, AND WHETHER IT WAS REAL.
--
-- Both tables land EMPTY. Nothing writes them yet: the mark-paid path still writes the invoice
-- columns directly, and the backfill of historic payments is a separate, reviewed step. Creating
-- them first means the ledger's shape is settled before anything depends on it.
--
-- StripeEvent.livemode is NULLABLE and not backfilled. Rows written before this column genuinely do
-- not know which mode they were; `false` would be a claim that they were test events. Unknown, not
-- test — the same honest-null rule as amount_paid_pennies and account_terms_days.
ALTER TABLE "StripeEvent" ADD COLUMN "livemode" BOOLEAN;

CREATE TABLE "Payment" (
  "id"                      TEXT NOT NULL,
  "group_id"                TEXT NOT NULL,
  "invoice_id"              TEXT NOT NULL,
  "site_id"                 TEXT,
  "provider"                TEXT NOT NULL DEFAULT 'manual',
  "status"                  TEXT NOT NULL DEFAULT 'succeeded',
  "amount_pennies"          INTEGER NOT NULL,
  "currency"                TEXT NOT NULL DEFAULT 'GBP',
  "payment_intent_id"       TEXT,
  "charge_id"               TEXT,
  "stripe_fee_pennies"      INTEGER,
  "application_fee_pennies" INTEGER,
  "application_fee_id"      TEXT,
  "fee_rate_id"             TEXT,
  "payment_method_id"       TEXT,
  "payment_method_snapshot" TEXT,
  "source_ref"              TEXT NOT NULL,
  "reconstructed"           BOOLEAN NOT NULL DEFAULT false,
  "collected_at"            TIMESTAMP(3) NOT NULL,
  "created_at"              TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "created_by"              TEXT,
  CONSTRAINT "Payment_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Refund" (
  "id"                               TEXT NOT NULL,
  "group_id"                         TEXT NOT NULL,
  "payment_id"                       TEXT NOT NULL,
  "amount_pennies"                   INTEGER NOT NULL,
  "currency"                         TEXT NOT NULL DEFAULT 'GBP',
  "reason"                           TEXT,
  "refund_id"                        TEXT,
  "application_fee_refunded_pennies" INTEGER,
  "source_ref"                       TEXT NOT NULL,
  "created_at"                       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "created_by"                       TEXT,
  CONSTRAINT "Refund_pkey" PRIMARY KEY ("id")
);

-- source_ref is THE idempotency key on both: a redelivered webhook writes once or not at all.
CREATE UNIQUE INDEX "Payment_source_ref_key"        ON "Payment"("source_ref");
CREATE UNIQUE INDEX "Payment_payment_intent_id_key" ON "Payment"("payment_intent_id");
CREATE UNIQUE INDEX "Refund_source_ref_key"         ON "Refund"("source_ref");
CREATE UNIQUE INDEX "Refund_refund_id_key"          ON "Refund"("refund_id");

CREATE INDEX "Payment_group_id_collected_at_idx" ON "Payment"("group_id", "collected_at");
CREATE INDEX "Payment_invoice_id_idx"            ON "Payment"("invoice_id");
CREATE INDEX "Payment_status_idx"                ON "Payment"("status");
CREATE INDEX "Refund_group_id_created_at_idx"    ON "Refund"("group_id", "created_at");

-- Cascade from the tenant and the invoice: a purged tenant must not leave money rows behind, and
-- lib/tenant-purge already relies on FK cascade for everything group-keyed.
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_group_id_fkey"
  FOREIGN KEY ("group_id") REFERENCES "Group"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_invoice_id_fkey"
  FOREIGN KEY ("invoice_id") REFERENCES "Invoice"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_payment_method_id_fkey"
  FOREIGN KEY ("payment_method_id") REFERENCES "PaymentMethod"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Refund" ADD CONSTRAINT "Refund_group_id_fkey"
  FOREIGN KEY ("group_id") REFERENCES "Group"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Refund" ADD CONSTRAINT "Refund_payment_id_fkey"
  FOREIGN KEY ("payment_id") REFERENCES "Payment"("id") ON DELETE CASCADE ON UPDATE CASCADE;
