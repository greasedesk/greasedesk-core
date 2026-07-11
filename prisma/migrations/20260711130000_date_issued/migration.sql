-- Invoice.date_issued: the editable DOCUMENT issue/billing date (mirrors date_paid). NULL on
-- pre-existing invoices (effective reads fall back to issued_at, the mint attestation).
ALTER TABLE "Invoice" ADD COLUMN "date_issued" TIMESTAMP(3);
