-- Append-only correction log for a void reason. ADDITIVE ONLY (no renames) — same reason as the
-- previous two migrations: `prisma migrate deploy` runs during the build while the PREVIOUS
-- deployment is still serving.
ALTER TABLE "Invoice" ADD COLUMN "void_reason_corrections" JSONB;
