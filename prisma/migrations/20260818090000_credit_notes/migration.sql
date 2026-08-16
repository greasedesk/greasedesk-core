-- CREDIT NOTES: an immutable VAT correction against an immutable invoice.
--
-- The accountant's ruling (2026-08-16): correcting a wrong figure on an issued invoice requires a
-- credit note plus a replacement, not an amendment in place; and a refund needs a credit note,
-- because the refunded stamp proves the payment event but does NOT reverse output VAT. Every refund
-- until now has left the garage's VAT record overstated.
--
-- FOUR CONCEPTS, NOT ONE: Invoice (immutable commercial charge), CreditNote (immutable VAT
-- correction, own sequence), Payment/Refund (money movement — already built), and the management
-- ledger (already built, the CASH clock). The cash clock and the VAT clock are EXPECTED to differ;
-- both are correct and they answer different questions.
--
-- Its own counter, for the same reason the historical series has one: issuing a correction must
-- never advance the chargeable counter, and VATREC13040 requires a credit note to carry its own
-- identifying number.

ALTER TABLE "InvoiceSequence" ADD COLUMN "credit_note_last_value" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Group" ADD COLUMN "invoice_credit_note_prefix" TEXT NOT NULL DEFAULT 'CN';

CREATE TABLE "CreditNote" (
  "id"                          TEXT NOT NULL,
  "group_id"                    TEXT NOT NULL,
  "site_id"                     TEXT NOT NULL,
  "invoice_id"                  TEXT NOT NULL,
  "sequence_value"              INTEGER NOT NULL,
  "credit_note_number"          TEXT NOT NULL,
  "date_issued"                 TIMESTAMP(3) NOT NULL,
  "issued_at"                   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "reason"                      TEXT NOT NULL,
  "refund_id"                   TEXT,
  "vat_registered_at_issue"     BOOLEAN NOT NULL,
  "company_name_snapshot"       TEXT NOT NULL,
  "company_vat_number_snapshot" TEXT,
  "company_address_snapshot"    TEXT,
  "customer_name_snapshot"      TEXT NOT NULL,
  "customer_address_snapshot"   TEXT,
  "created_by"                  TEXT,
  "created_at"                  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CreditNote_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "CreditNoteLine" (
  "id"             TEXT NOT NULL,
  "credit_note_id" TEXT NOT NULL,
  "position"       INTEGER NOT NULL,
  "description"    TEXT NOT NULL,
  "item_type"      "ItemType" NOT NULL,
  "qty"            DECIMAL(12,2) NOT NULL,
  "unit_price"     DECIMAL(12,2) NOT NULL,
  "vat_rate"       DECIMAL(5,2) NOT NULL,
  "line_total"     DECIMAL(12,2) NOT NULL,
  "line_vat"       DECIMAL(12,2) NOT NULL,
  CONSTRAINT "CreditNoteLine_pkey" PRIMARY KEY ("id")
);

-- GAPLESS PER TENANT, like the invoice series.
CREATE UNIQUE INDEX "CreditNote_group_id_sequence_value_key" ON "CreditNote"("group_id", "sequence_value");
-- The VAT read groups by period: (tenant, date_issued) is the access path.
CREATE INDEX "CreditNote_group_id_date_issued_idx" ON "CreditNote"("group_id", "date_issued");
CREATE INDEX "CreditNote_invoice_id_idx" ON "CreditNote"("invoice_id");
CREATE INDEX "CreditNoteLine_credit_note_id_idx" ON "CreditNoteLine"("credit_note_id");

-- RESTRICT on the invoice, not CASCADE: a credit note outliving its invoice would be a correction
-- against nothing, and deleting an invoice that has been credited must be refused, not cascaded.
ALTER TABLE "CreditNote" ADD CONSTRAINT "CreditNote_group_id_fkey"
  FOREIGN KEY ("group_id") REFERENCES "Group"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CreditNote" ADD CONSTRAINT "CreditNote_invoice_id_fkey"
  FOREIGN KEY ("invoice_id") REFERENCES "Invoice"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CreditNote" ADD CONSTRAINT "CreditNote_refund_id_fkey"
  FOREIGN KEY ("refund_id") REFERENCES "Refund"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "CreditNoteLine" ADD CONSTRAINT "CreditNoteLine_credit_note_id_fkey"
  FOREIGN KEY ("credit_note_id") REFERENCES "CreditNote"("id") ON DELETE CASCADE ON UPDATE CASCADE;
