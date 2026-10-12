-- @migration: additive
--
-- OPTIONS ON A QUOTE: one new table, and four new NULLABLE columns on two existing ones. Nothing
-- deployed writes any of them.
--
-- QuoteOption's foreign key is folded into its CREATE TABLE rather than left as the ALTER that
-- classifies constraining on a table created twenty lines earlier. QuoteVersionLine.option_id
-- deliberately carries NO foreign key: that one WOULD be an ALTER on an existing table, and it
-- joins the standing FK audit with the other unconstrained *_id columns instead of costing this
-- slice a second push. Same reasoning as 20261011190000_backup_run and 20261011200000_export_job.

-- AlterTable
ALTER TABLE "QuoteVersion" ADD COLUMN     "narrative" TEXT,
ADD COLUMN     "resolved_from_version" INTEGER,
ADD COLUMN     "selection_json" JSONB;

-- AlterTable
ALTER TABLE "QuoteVersionLine" ADD COLUMN     "option_id" TEXT;

-- CreateTable
CREATE TABLE "QuoteOption" (
    "id" TEXT NOT NULL,
    "quote_version_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "net_pennies" INTEGER NOT NULL,
    "vat_pennies" INTEGER NOT NULL,
    "gross_pennies" INTEGER NOT NULL,
    "group_key" TEXT,
    "incentive_kind" TEXT,
    "incentive_label" TEXT,
    "incentive_ex_pennies" INTEGER,
    "incentive_vatable" BOOLEAN,
    "incentive_gross_off_pennies" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "QuoteOption_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "QuoteOption_quote_version_id_fkey" FOREIGN KEY ("quote_version_id") REFERENCES "QuoteVersion"("id") ON DELETE CASCADE ON UPDATE NO ACTION
);

-- CreateIndex
CREATE INDEX "QuoteOption_quote_version_id_position_idx" ON "QuoteOption"("quote_version_id", "position");

-- CreateIndex
CREATE INDEX "QuoteVersionLine_option_id_idx" ON "QuoteVersionLine"("option_id");


