-- Bundled-line splits, in STAGING ONLY. The ledger is untouched by this migration and by any
-- split: children exist only on StagedLine until commit, where they are emitted as job-card items
-- INSTEAD OF their parent. sum(children) == parent to the penny is enforced on save and at commit,
-- so the invoice total can never move.

ALTER TABLE "StagedLine" ADD COLUMN "parent_line_id" TEXT;
CREATE INDEX "StagedLine_parent_line_id_idx" ON "StagedLine"("parent_line_id");
ALTER TABLE "StagedLine" ADD CONSTRAINT "StagedLine_parent_line_id_fkey"
  FOREIGN KEY ("parent_line_id") REFERENCES "StagedLine"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- A remembered split, keyed like CatalogueAlias so it re-offers retroactively across the batch.
CREATE TABLE "LineSplitTemplate" (
  "id" TEXT NOT NULL,
  "group_id" TEXT NOT NULL,
  "description" TEXT NOT NULL,
  "unit_price" DECIMAL(12,4),
  "children_json" JSONB NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "LineSplitTemplate_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "LineSplitTemplate_group_id_description_unit_price_key"
  ON "LineSplitTemplate"("group_id", "description", "unit_price");
ALTER TABLE "LineSplitTemplate" ADD CONSTRAINT "LineSplitTemplate_group_id_fkey"
  FOREIGN KEY ("group_id") REFERENCES "Group"("id") ON DELETE CASCADE ON UPDATE CASCADE;
