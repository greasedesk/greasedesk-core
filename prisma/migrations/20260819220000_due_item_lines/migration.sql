-- The link between a finding and the estimate line it became. Invoicing that line does NOT
-- close the finding: discs today and pads next month is one invoice and two different answers.

-- CreateTable
CREATE TABLE "DueItemLine" (
    "id" TEXT NOT NULL,
    "group_id" TEXT NOT NULL,
    "due_item_id" TEXT NOT NULL,
    "job_card_item_id" TEXT NOT NULL,
    "linked_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DueItemLine_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DueItemLine_group_id_due_item_id_idx" ON "DueItemLine"("group_id", "due_item_id");

-- CreateIndex
CREATE INDEX "DueItemLine_job_card_item_id_idx" ON "DueItemLine"("job_card_item_id");

-- CreateIndex
CREATE UNIQUE INDEX "DueItemLine_due_item_id_job_card_item_id_key" ON "DueItemLine"("due_item_id", "job_card_item_id");

-- AddForeignKey
ALTER TABLE "DueItemLine" ADD CONSTRAINT "DueItemLine_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "Group"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DueItemLine" ADD CONSTRAINT "DueItemLine_due_item_id_fkey" FOREIGN KEY ("due_item_id") REFERENCES "VehicleDueItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DueItemLine" ADD CONSTRAINT "DueItemLine_job_card_item_id_fkey" FOREIGN KEY ("job_card_item_id") REFERENCES "JobCardItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

