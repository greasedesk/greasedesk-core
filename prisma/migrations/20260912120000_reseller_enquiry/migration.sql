-- @migration: additive
--
-- THE RESELLER ENQUIRY STORE. The public reseller site's interest form emailed CONTACT_FORM_TO and
-- kept nothing, so a provider failure lost the enquiry and no number could be read back. This is the
-- record; the email still goes, independently.
--
-- Hand-written, applied with scripts/migrate-apply.mjs.
--
-- ── WHY THE CHECKS SIT INSIDE THE CREATE TABLE ──────────────────────────────────────────────────
-- Not style. A constraint added by its own ALTER TABLE classifies as CONSTRAINING, because the
-- classifier cannot tell which table's existing rows it might reject. Declared inside the CREATE
-- TABLE it provably cannot reach an existing writer: the table did not exist a statement ago, and
-- production cannot insert into a table it has never heard of. So this whole migration is additive
-- and applies without waiting for a deploy — which is the case lib/migration-deploy-rules's
-- SELF_CONTAINED_ADDITIVE refinement was written for.
CREATE TABLE "ResellerEnquiry" (
    "id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "name" TEXT NOT NULL,
    "email" TEXT,
    "company" TEXT,
    "area" TEXT,
    "phone" TEXT,
    "message" TEXT,
    "email_delivered" BOOLEAN NOT NULL,
    "personal_stripped_at" TIMESTAMP(3),
    "personal_stripped_reason" TEXT,
    CONSTRAINT "ResellerEnquiry_pkey" PRIMARY KEY ("id"),
    -- The pair moves together or not at all: an absence must never be ambiguous.
    CONSTRAINT "ResellerEnquiry_strip_pair_chk"
      CHECK (("personal_stripped_at" IS NULL) = ("personal_stripped_reason" IS NULL)),
    -- lib/prospects::STRIP_REASONS. A vocabulary, in the database, so a typo cannot be stored.
    CONSTRAINT "ResellerEnquiry_strip_reason_chk"
      CHECK ("personal_stripped_reason" IS NULL OR "personal_stripped_reason" IN ('retention', 'unsubscribed', 'signed_up'))
);

CREATE INDEX "ResellerEnquiry_created_at_idx" ON "ResellerEnquiry"("created_at");
