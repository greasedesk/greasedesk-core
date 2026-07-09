-- Invoicing settings tab + tax-label i18n + date-paid. All additive.
ALTER TABLE "Group" ADD COLUMN "invoice_reply_to" TEXT;        -- business Reply-To (falls back to billing_email)
ALTER TABLE "Group" ADD COLUMN "invoice_sender_name" TEXT;     -- display name on the GreaseDesk-owned From (falls back to group_name)
ALTER TABLE "Group" ADD COLUMN "invoice_footer_text" TEXT;     -- payment terms / footer block (multi-line, rendered on the document)
ALTER TABLE "Group" ADD COLUMN "invoice_bcc" TEXT;             -- garage-copy BCC (falls back to billing_email)
ALTER TABLE "Group" ADD COLUMN "logo_r2_key" TEXT;             -- tenant logo in R2 ({group}/branding/...)
ALTER TABLE "Group" ADD COLUMN "tax_label" TEXT NOT NULL DEFAULT 'VAT'; -- admin-SET (VAT/GST/Sales Tax) — never derived from country

ALTER TABLE "Invoice" ADD COLUMN "date_paid" TIMESTAMP(3);     -- the DOCUMENT fact (editable, audited); paid_at stays the attestation timestamp
