-- Invoice Import: staging + line memory + provenance.
-- STAGING IS NEVER THE LEDGER. Nothing here is read by any financial report; only an explicit
-- commit drives the app's own write paths. Additive only — no existing row is read or changed.

CREATE TYPE "ImportBatchStatus"   AS ENUM ('open', 'committing', 'committed', 'abandoned');
CREATE TYPE "StagedInvoiceStatus" AS ENUM ('pending', 'in_progress', 'committed', 'skipped');

CREATE TABLE "ImportBatch" (
  "id" TEXT NOT NULL, "group_id" TEXT NOT NULL, "site_id" TEXT NOT NULL,
  "label" TEXT NOT NULL, "source" TEXT NOT NULL DEFAULT 'xero_pdf',
  "status" "ImportBatchStatus" NOT NULL DEFAULT 'open',
  "created_by" TEXT, "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ImportBatch_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "ImportBatch_group_id_status_idx" ON "ImportBatch"("group_id", "status");

CREATE TABLE "StagedInvoice" (
  "id" TEXT NOT NULL, "batch_id" TEXT NOT NULL, "group_id" TEXT NOT NULL,
  "external_number" TEXT NOT NULL, "issue_date" TIMESTAMP(3) NOT NULL, "registration" TEXT,
  "subtotal_printed" DECIMAL(12,2) NOT NULL, "subtotal_parsed" DECIMAL(12,2) NOT NULL,
  "reconciled" BOOLEAN NOT NULL DEFAULT false,
  "vat_printed" DECIMAL(12,2), "vat_computed" DECIMAL(12,2),
  "planned_start_at" TIMESTAMP(3), "planned_resource_id" TEXT,
  "status" "StagedInvoiceStatus" NOT NULL DEFAULT 'pending',
  "skip_reason" TEXT, "wizard_step" INTEGER NOT NULL DEFAULT 1,
  "job_card_id" TEXT, "invoice_id" TEXT, "raw_text" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "StagedInvoice_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "StagedInvoice_group_id_external_number_key" ON "StagedInvoice"("group_id", "external_number");
CREATE INDEX "StagedInvoice_batch_id_status_idx" ON "StagedInvoice"("batch_id", "status");

CREATE TABLE "StagedLine" (
  "id" TEXT NOT NULL, "staged_invoice_id" TEXT NOT NULL, "position" INTEGER NOT NULL,
  "description" TEXT NOT NULL, "continuation_text" TEXT,
  "qty" DECIMAL(12,4) NOT NULL, "unit_price" DECIMAL(12,4) NOT NULL,
  "vat_text" TEXT, "amount" DECIMAL(12,2) NOT NULL,
  "kind" "ItemType", "catalogue_item_id" TEXT,
  "parts_cost" DECIMAL(12,2), "labour_hours" DECIMAL(6,2), "cost_basis" TEXT,
  "is_adjustment" BOOLEAN NOT NULL DEFAULT false,
  CONSTRAINT "StagedLine_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "StagedLine_staged_invoice_id_position_idx" ON "StagedLine"("staged_invoice_id", "position");

-- Line memory: keyed on description + unit_price, because the same description at a different
-- price is a DIFFERENT job (engine tiers).
CREATE TABLE "CatalogueAlias" (
  "id" TEXT NOT NULL, "group_id" TEXT NOT NULL, "catalogue_item_id" TEXT NOT NULL,
  "description" TEXT NOT NULL, "unit_price" DECIMAL(12,4),
  "source" TEXT NOT NULL DEFAULT 'import',
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CatalogueAlias_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "CatalogueAlias_group_id_description_unit_price_key" ON "CatalogueAlias"("group_id", "description", "unit_price");
CREATE INDEX "CatalogueAlias_catalogue_item_id_idx" ON "CatalogueAlias"("catalogue_item_id");

-- Provenance on the ledger objects.
ALTER TABLE "JobCard"     ADD COLUMN "is_imported" BOOLEAN NOT NULL DEFAULT false,
                          ADD COLUMN "import_batch_id" TEXT;
ALTER TABLE "Invoice"     ADD COLUMN "is_imported" BOOLEAN NOT NULL DEFAULT false,
                          ADD COLUMN "external_ref" TEXT,
                          ADD COLUMN "cost_basis" TEXT;
ALTER TABLE "InvoiceLine" ADD COLUMN "cost_basis" TEXT;
ALTER TABLE "JobCardItem" ADD COLUMN "cost_basis" TEXT;

ALTER TABLE "ImportBatch" ADD CONSTRAINT "ImportBatch_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "Group"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ImportBatch" ADD CONSTRAINT "ImportBatch_site_id_fkey" FOREIGN KEY ("site_id") REFERENCES "Site"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "StagedInvoice" ADD CONSTRAINT "StagedInvoice_batch_id_fkey" FOREIGN KEY ("batch_id") REFERENCES "ImportBatch"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "StagedLine" ADD CONSTRAINT "StagedLine_staged_invoice_id_fkey" FOREIGN KEY ("staged_invoice_id") REFERENCES "StagedInvoice"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CatalogueAlias" ADD CONSTRAINT "CatalogueAlias_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "Group"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CatalogueAlias" ADD CONSTRAINT "CatalogueAlias_catalogue_item_id_fkey" FOREIGN KEY ("catalogue_item_id") REFERENCES "CatalogueItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;
