-- Payment methods: admin-configurable list, each with a clearance behaviour that drives the
-- paid-state machine (instant = skip the window; windowed = current behaviour; manual = pending
-- until explicitly confirmed — the cron skips these because confirm_due_at stays NULL).
CREATE TYPE "PaymentClearance" AS ENUM ('instant', 'windowed', 'manual');

CREATE TABLE "PaymentMethod" (
  "id" TEXT NOT NULL,
  "group_id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "behaviour" "PaymentClearance" NOT NULL DEFAULT 'windowed',
  "active" BOOLEAN NOT NULL DEFAULT true,
  "position" INTEGER NOT NULL DEFAULT 0,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PaymentMethod_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "PaymentMethod_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "Group"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "PaymentMethod_group_id_idx" ON "PaymentMethod"("group_id");

ALTER TABLE "Invoice" ADD COLUMN "payment_method_id" TEXT;
ALTER TABLE "Invoice" ADD COLUMN "payment_method_snapshot" TEXT; -- name at mark-paid (renames never rewrite history)
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_payment_method_id_fkey" FOREIGN KEY ("payment_method_id") REFERENCES "PaymentMethod"("id") ON DELETE SET NULL ON UPDATE CASCADE;
