-- Additive only: a nullable column. NULL on every existing row is CORRECT and is the whole design —
-- lib/ops-email falls back to invoice_reply_to then billing_email, so no tenant's behaviour changes
-- until an owner sets this deliberately. Nothing is backfilled.
ALTER TABLE "Group" ADD COLUMN "ops_email" TEXT;
