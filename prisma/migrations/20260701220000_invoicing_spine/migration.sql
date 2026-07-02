-- Invoicing spine. ADDITIVE ONLY: new enum + 3 new tables, plus additive ADD COLUMN on Group
-- (numbering format) and Customer (billing address). No existing quote/card table is altered.

CREATE TYPE "InvoiceStatus" AS ENUM ('issued', 'paid');

-- Per-tenant number display format (defaults: no prefix, 4-wide zero pad → "0001").
ALTER TABLE "Group" ADD COLUMN "invoice_prefix"    TEXT    NOT NULL DEFAULT '';
ALTER TABLE "Group" ADD COLUMN "invoice_pad_width" INTEGER NOT NULL DEFAULT 4;

-- Customer billing address (source for Invoice.customer_address_snapshot).
ALTER TABLE "Customer" ADD COLUMN "address" TEXT;

-- Monotonic per-tenant counter (one row per tenant). last_value NOT seeded — starts at 0.
CREATE TABLE "InvoiceSequence" (
  "group_id"   TEXT NOT NULL,
  "last_value" INTEGER NOT NULL DEFAULT 0,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "InvoiceSequence_pkey" PRIMARY KEY ("group_id")
);
ALTER TABLE "InvoiceSequence" ADD CONSTRAINT "InvoiceSequence_group_id_fkey"
  FOREIGN KEY ("group_id") REFERENCES "Group"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Invoice (one per job card at issue; header snapshot; sticky number).
CREATE TABLE "Invoice" (
  "id"                          TEXT NOT NULL,
  "group_id"                    TEXT NOT NULL,
  "job_card_id"                 TEXT NOT NULL,
  "site_id"                     TEXT NOT NULL,
  "status"                      "InvoiceStatus" NOT NULL DEFAULT 'issued',
  "sequence_value"              INTEGER NOT NULL,
  "invoice_number"              TEXT,
  "issued_at"                   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "paid_at"                     TIMESTAMP(3),
  "company_name_snapshot"       TEXT NOT NULL,
  "company_vat_number_snapshot" TEXT,
  "company_address_snapshot"    TEXT,
  "customer_name_snapshot"      TEXT NOT NULL,
  "customer_address_snapshot"   TEXT,
  "vehicle_reg_snapshot"        TEXT,
  "vehicle_desc_snapshot"       TEXT,
  "vat_registered_at_issue"     BOOLEAN NOT NULL,
  "created_at"                  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Invoice_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "Invoice_job_card_id_key"             ON "Invoice"("job_card_id");
CREATE UNIQUE INDEX "Invoice_group_id_sequence_value_key" ON "Invoice"("group_id", "sequence_value");
CREATE INDEX "Invoice_group_id_idx" ON "Invoice"("group_id");
CREATE INDEX "Invoice_site_id_idx"  ON "Invoice"("site_id");
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_group_id_fkey"
  FOREIGN KEY ("group_id") REFERENCES "Group"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_job_card_id_fkey"
  FOREIGN KEY ("job_card_id") REFERENCES "JobCard"("id") ON DELETE NO ACTION ON UPDATE CASCADE;
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_site_id_fkey"
  FOREIGN KEY ("site_id") REFERENCES "Site"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- Invoice lines (snapshot copy of the card lines at issue; editable until paid; unit_cost internal).
CREATE TABLE "InvoiceLine" (
  "id"                TEXT NOT NULL,
  "invoice_id"        TEXT NOT NULL,
  "description"       TEXT NOT NULL,
  "qty"               DECIMAL(12,2) NOT NULL DEFAULT 1,
  "unit_price"        DECIMAL(12,2) NOT NULL DEFAULT 0,
  "vat_rate"          DECIMAL(5,2)  NOT NULL DEFAULT 0,
  "line_vat"          DECIMAL(12,2) NOT NULL DEFAULT 0,
  "line_total"        DECIMAL(12,2) NOT NULL DEFAULT 0,
  "unit_cost"         DECIMAL(12,2) NOT NULL DEFAULT 0,
  "catalogue_item_id" TEXT,
  "position"          INTEGER NOT NULL DEFAULT 0,
  "created_at"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "InvoiceLine_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "InvoiceLine_invoice_id_idx" ON "InvoiceLine"("invoice_id");
ALTER TABLE "InvoiceLine" ADD CONSTRAINT "InvoiceLine_invoice_id_fkey"
  FOREIGN KEY ("invoice_id") REFERENCES "Invoice"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- NOTE: catalogue_item_id has NO FK yet (no catalogue table). The column exists now so the FK can be
-- added later with zero InvoiceLine migration.
