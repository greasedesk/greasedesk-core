-- Per-user invoice-raising grant (ADMIN-set, off by default). Additive + non-destructive: every
-- existing user defaults to false, so no one gains authority silently. Grants ONLY the
-- in_progress→invoiced transition + retail price visibility (server-enforced via canIssueInvoice) —
-- NOT mark-paid, NOT unlock (ADMIN), NOT unit_cost/margin.
ALTER TABLE "User" ADD COLUMN "can_invoice" BOOLEAN NOT NULL DEFAULT false;
