-- The customer's OWN answers to intake-report findings — token-authenticated and append-only.
-- Kept apart from VehicleDueItem.customer_response on purpose: the customer's record is
-- authoritative about what the CUSTOMER SAID, the garage's field about what the GARAGE WILL ACT ON,
-- and a disagreement between them must be legible rather than impossible.

-- CreateEnum
CREATE TYPE "CustomerAnswer" AS ENUM ('yes', 'no', 'call_me');

-- AlterEnum

-- CreateTable
CREATE TABLE "DueItemCustomerAnswer" (
    "id" TEXT NOT NULL,
    "group_id" TEXT NOT NULL,
    "due_item_id" TEXT NOT NULL,
    "answer" "CustomerAnswer" NOT NULL,
    "answered_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "magic_link_id" TEXT,

    CONSTRAINT "DueItemCustomerAnswer_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DueItemCustomerAnswer_due_item_id_answered_at_idx" ON "DueItemCustomerAnswer"("due_item_id", "answered_at");

-- CreateIndex
CREATE INDEX "DueItemCustomerAnswer_group_id_idx" ON "DueItemCustomerAnswer"("group_id");

-- AddForeignKey
ALTER TABLE "DueItemCustomerAnswer" ADD CONSTRAINT "DueItemCustomerAnswer_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "Group"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DueItemCustomerAnswer" ADD CONSTRAINT "DueItemCustomerAnswer_due_item_id_fkey" FOREIGN KEY ("due_item_id") REFERENCES "VehicleDueItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

