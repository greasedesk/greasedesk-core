-- @migration: additive
--
-- SLICE E — THE AFFILIATE PORTAL: a payee the affiliate PROPOSES, and the terms they accepted.
--
-- Two brand-new tables and one new column. Nothing deployed reads or writes any of them, so this is
-- safe to apply at any time, in either order relative to the code.
--
-- ── WHY A REQUEST TABLE AND NOT A FORM THAT WRITES Rep.bank_* ───────────────────────────────────
-- Rep's bank columns are operator-write-only on purpose: a rep has no password, the magic link IS
-- the credential, and the mailbox IS the account. A self-serve bank form would therefore let whoever
-- holds the inbox redirect the money. The affiliate dashboard needs to collect the details anyway,
-- so the two correct rules are reconciled by a third state: the affiliate PROPOSES here, the owner
-- APPLIES it in the Engine Room, and only that write touches Rep.bank_*. Nothing is ever paid from
-- this table.
--
-- ── EVERY CONSTRAINT IS INSIDE ITS CREATE TABLE, DELIBERATELY ───────────────────────────────────
-- A separate ADD CONSTRAINT / CREATE UNIQUE INDEX classifies CONSTRAINING (see
-- lib/migration-deploy-rules) and would cost the two-push dance for constraints that cannot reach a
-- writer, because the table did not exist a moment ago. Names match what Prisma names the same
-- field-level attributes — <Table>_<column>_fkey, <Table>_pkey — so the schema and the database are
-- identical by construction and `migrate diff` stays empty.
--
-- ── WHAT IS ENCRYPTED AND WHAT IS NOT ──────────────────────────────────────────────────────────
-- sort code and account number: AES-256-GCM (lib/payee-crypto), stored v1:<iv>:<tag>:<ct>.
-- account NAME: plaintext. It is a person's name, it has to print on a remittance, and encrypting it
-- would cost "paying J Smith" on the approval screen for nothing.
-- account_last4: derived at write time, and it is what makes the common read path cheap AND safe —
-- the affiliate's own "ending ••34" needs no key, no decrypt and no audit row. A reveal is an event;
-- an affiliate glancing at their own dashboard is not one, and must not write one.

CREATE TABLE "RepPayeeRequest" (
  "id"                 TEXT         NOT NULL,
  "rep_id"             TEXT         NOT NULL,
  -- 'self' | 'nominee' — the set is in the CHECK below, as AffiliateWaitlist_audience_chk does it.
  "payee_kind"         TEXT         NOT NULL,
  "account_name"       TEXT         NOT NULL,
  "sort_code_enc"      TEXT         NOT NULL,
  "account_number_enc" TEXT         NOT NULL,
  -- NO length CHECK. Four digits is true of every UK account number and this is GB-only today, but
  -- the column is a DISPLAY string and a length rule on it would have to be relaxed — a constraining
  -- migration — the first time a non-UK account arrives. The writer derives it; the gate asserts it.
  "account_last4"      TEXT         NOT NULL,
  -- NOMINEE ONLY. NULL = they are paying themselves, or gave no address for the nominee. It exists
  -- to be checked against the Users of the garages this affiliate referred — the one half of
  -- "never the referred garage or its staff" that can be mechanised.
  "nominee_email"      TEXT,
  -- 'pending' | 'applied' | 'rejected' | 'superseded'
  "status"             TEXT         NOT NULL DEFAULT 'pending',
  "requested_at"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "decided_at"         TIMESTAMP(3),
  "decided_by"         TEXT,
  "reject_reason"      TEXT,
  CONSTRAINT "RepPayeeRequest_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "RepPayeeRequest_rep_id_fkey" FOREIGN KEY ("rep_id") REFERENCES "Rep"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  -- THE TWO CLOSED SETS, IN THE DATABASE. Free on a new table, and the same choice
  -- AffiliateWaitlist_audience_chk made; lib/payee holds the same lists for the type system, and a
  -- gate asserts the two agree rather than trusting that they do.
  CONSTRAINT "RepPayeeRequest_payee_kind_chk" CHECK ("payee_kind" IN ('self', 'nominee')),
  CONSTRAINT "RepPayeeRequest_status_chk" CHECK ("status" IN ('pending', 'applied', 'rejected', 'superseded')),
  -- PENDING IFF UNDECIDED. The pairing CommissionEntry_invoiced_chk uses, for the same reason: a row
  -- that says 'applied' with no date, or 'pending' with one, is a row a screen renders confidently
  -- and wrongly. A supersede IS a decision and stamps the date with decided_by NULL — the platform
  -- acted, not an operator, which is the sentinel SuperAdminAudit already uses.
  CONSTRAINT "RepPayeeRequest_decided_chk" CHECK (("status" = 'pending') = ("decided_at" IS NULL))
);

CREATE INDEX "RepPayeeRequest_rep_id_status_idx" ON "RepPayeeRequest"("rep_id", "status");

-- ── WHAT THEY ACCEPTED, AND WHEN. APPEND-ONLY. ─────────────────────────────────────────────────
-- Rep.terms_accepted_at already records THAT they accepted, and it keeps that meaning: the first
-- acceptance. It cannot answer WHICH version, and a single terms_version column would answer it
-- only until the terms are re-issued, at which point the update erases the evidence of what the
-- first acceptance was to. An acceptance is a legal fact, so it gets a row, and the row is never
-- updated. Same standing rule as AuditLog.
CREATE TABLE "RepTermsAcceptance" (
  "id"          TEXT         NOT NULL,
  "rep_id"      TEXT         NOT NULL,
  -- The Document version stamp in force at acceptance (e.g. '2026-11-01'), NOT a lookup of the
  -- latest: what they agreed to is frozen, which is the whole reason Document versions legal pages.
  "version"     TEXT         NOT NULL,
  -- The exact Document row, when we have it. NULL = recorded from the version stamp alone.
  "document_id" TEXT,
  "accepted_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "RepTermsAcceptance_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "RepTermsAcceptance_rep_id_fkey" FOREIGN KEY ("rep_id") REFERENCES "Rep"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE INDEX "RepTermsAcceptance_rep_id_accepted_at_idx" ON "RepTermsAcceptance"("rep_id", "accepted_at");

-- ── THE LAST FOUR, ON Rep ──────────────────────────────────────────────────────────────────────
-- So the applied details can be shown as "ending ••34" without decrypting anything. NO CHECK pairs
-- it with the other three: a CHECK on an EXISTING table can reach a deployed writer, which is what
-- makes this migration additive, and Rep_bank_chk already holds the three columns that matter. The
-- pairing is held by having ONE writer (the Engine Room apply path) set all four together, and a
-- gate clause asserts no row carries a last4 without the three.
-- NULL = we hold no bank details, or they predate this column and the one-off has not run yet.
ALTER TABLE "Rep" ADD COLUMN "bank_account_last4" TEXT;
