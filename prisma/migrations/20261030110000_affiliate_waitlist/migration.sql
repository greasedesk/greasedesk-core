-- @migration: additive
--
-- WHO IS WAITING FOR THE AFFILIATE PROGRAMME TO OPEN (owner, 2026-10-30).
--
-- The public affiliate site shows everything whether or not joining is open; when it is shut, the
-- join button is replaced by "leave your email and we'll tell you". This is where those addresses
-- go, so the owner can read them in the Engine Room. It is NOT a signup: no Rep row, no code, no
-- terms accepted.
--
-- A BRAND-NEW TABLE, so nothing deployed reads or writes it and this is safe to apply at any time.
--
-- THE UNIQUE IS INSIDE THE CREATE TABLE, and that is deliberate rather than stylistic. A separate
-- `CREATE UNIQUE INDEX` statement classifies CONSTRAINING (lib/migration-deploy-rules: "production
-- may already create duplicates") and would cost the two-push dance for a constraint that cannot
-- reach a writer, because the table did not exist a moment ago. A table's own UNIQUE is inside
-- SELF_CONTAINED_ADDITIVE for exactly this case. The constraint is NAMED what Prisma names a
-- field-level @unique — <Table>_<column>_key — so the schema and the database are identical by
-- construction and `migrate diff` stays empty.
--
-- THE CHECK IS THE SAME CASE: a new table's own CHECK constrains inserts into a table production has
-- never heard of. It holds the audience to the two values lib/affiliate-waitlist offers, with NULL
-- allowed because "they did not say" is a real answer.

CREATE TABLE "AffiliateWaitlist" (
  "id"         TEXT         NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "email"      TEXT         NOT NULL,
  "audience"   TEXT,
  CONSTRAINT "AffiliateWaitlist_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "AffiliateWaitlist_email_key" UNIQUE ("email"),
  CONSTRAINT "AffiliateWaitlist_audience_chk" CHECK ("audience" IS NULL OR "audience" IN ('trade', 'creator'))
);

CREATE INDEX "AffiliateWaitlist_created_at_idx" ON "AffiliateWaitlist"("created_at");
