-- @migration: additive
--
-- THE DRAFT HALF OF A QUOTE OPTION: one new table, and one new NULLABLE column on JobCardItem.
-- Nothing deployed writes either.
--
-- The foreign key is folded into the CREATE TABLE rather than left as the ALTER that classifies
-- constraining on a table created twenty lines earlier; JobCardItem.option_draft_id deliberately
-- carries none, joining the standing FK audit with the other unconstrained *_id columns. Same
-- reasoning as the three migrations before it.

-- AlterTable
ALTER TABLE "JobCardItem" ADD COLUMN     "option_draft_id" TEXT;

-- CreateTable
CREATE TABLE "QuoteOptionDraft" (
    "id" TEXT NOT NULL,
    "job_card_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "group_key" TEXT,
    "incentive_kind" TEXT,
    "incentive_label" TEXT,
    "incentive_ex_pennies" INTEGER,
    "incentive_vatable" BOOLEAN,
    "incentive_gross_off_pennies" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "QuoteOptionDraft_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "QuoteOptionDraft_job_card_id_fkey" FOREIGN KEY ("job_card_id") REFERENCES "JobCard"("id") ON DELETE CASCADE ON UPDATE NO ACTION
);

-- CreateIndex
CREATE INDEX "QuoteOptionDraft_job_card_id_position_idx" ON "QuoteOptionDraft"("job_card_id", "position");


