-- Invoices view permission: managers/admins always see it; this admin toggle extends it to
-- STANDARD (small garages / absent managers). Additive, default OFF per the toggle discipline.
ALTER TABLE "Group" ADD COLUMN "perm_standard_view_invoices" BOOLEAN NOT NULL DEFAULT false;
