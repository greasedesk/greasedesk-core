-- Bank-style paid lifecycle: issued -> paid_pending (mark-paid; reversible, silent) -> paid
-- (confirmed by the clearance cron; receipt sent). Additive; no existing paid invoices in prod.

ALTER TYPE "InvoiceStatus" ADD VALUE IF NOT EXISTS 'paid_pending' BEFORE 'paid';

ALTER TABLE "Invoice" ADD COLUMN "confirm_due_at" TIMESTAMP(3); -- pending-mark time + tenant window
ALTER TABLE "Invoice" ADD COLUMN "receipt_sent_at" TIMESTAMP(3); -- confirmation receipt delivered (null after confirm = visibly "receipt not sent")

ALTER TABLE "Group" ADD COLUMN "paid_confirm_window_hours" INTEGER NOT NULL DEFAULT 24;
