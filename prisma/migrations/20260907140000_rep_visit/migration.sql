-- REP VISITS, AND THE LEDGER COLUMN THAT REMEMBERS WHICH RATE BRANCH WAS USED.
--
-- Written by hand and applied with `migrate deploy`. `migrate dev` proposes a RESET of this
-- database, because two historical migrations were edited after being applied — see
-- docs/deferred-slices.md. Never run it here.
--
-- Everything below is DORMANT: nothing reads CommissionRate.amount_unvisited_pennies, nothing
-- writes a RepVisit. rep-visit-gate pins both, so wiring the money has to be a deliberate act.

-- ── THE ENTRY REMEMBERS ITS BRANCH ──────────────────────────────────────────────────────────────
-- NULL = no visit decision was applied. Today that is every row. NOT defaulted to false: false is
-- the decision "they had no visit", and an undecided entry has not made it.
ALTER TABLE "CommissionEntry" ADD COLUMN "visited" BOOLEAN;

-- ── THE EVIDENCE ────────────────────────────────────────────────────────────────────────────────
CREATE TABLE "RepVisit" (
    "id"               TEXT NOT NULL,
    "group_id"         TEXT NOT NULL,
    "site_id"          TEXT NOT NULL,
    "party_type"       TEXT NOT NULL,
    "party_id"         TEXT NOT NULL,
    "scanned_at"       TIMESTAMP(3) NOT NULL,
    "satisfies_period" TEXT,
    "source"           TEXT NOT NULL,
    "code_step"        INTEGER,
    "reason"           TEXT,
    "recorded_by"      TEXT,
    "created_at"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RepVisit_pkey" PRIMARY KEY ("id")
);

-- SINGLE-USE. A QR forwarded inside its ±1-step window is the attack; spending a step twice is what
-- this refuses. Postgres allows many NULLs in a unique index, so operator-recorded visits (which
-- carry no step) do not collide with one another.
CREATE UNIQUE INDEX "RepVisit_group_id_code_step_key" ON "RepVisit"("group_id", "code_step");
CREATE INDEX "RepVisit_group_id_satisfies_period_idx" ON "RepVisit"("group_id", "satisfies_period");
CREATE INDEX "RepVisit_party_type_party_id_idx" ON "RepVisit"("party_type", "party_id");

-- ── THE TWO RULES THE DATABASE ITSELF ENFORCES ──────────────────────────────────────────────────
-- Stated here as well as in lib/rep-visit, and that duplication is a known hazard: a CHECK has
-- drifted from the code twice in this schema (MarketingContact_reason_check, then
-- CostAllocation_one_owner_chk) and enum-drift-gate does not cover CHECKs — it compares pg_enum,
-- which is a different object. rep-visit-gate therefore ASKS THE DATABASE, by attempting each
-- violating write inside a transaction it always rolls back, rather than reading this file.
ALTER TABLE "RepVisit" ADD CONSTRAINT "RepVisit_source_chk"
    CHECK (source IN ('scan', 'operator'));

-- A visit must carry the evidence its own kind of record is made of: a scan carries the code step
-- it consumed, an operator visit carries the reason nobody could scan. A blank reason is not a
-- reason, which is why btrim is here and not left to a form.
ALTER TABLE "RepVisit" ADD CONSTRAINT "RepVisit_evidence_chk" CHECK (
      (source = 'scan'     AND code_step IS NOT NULL)
   OR (source = 'operator' AND reason IS NOT NULL AND btrim(reason) <> '')
);
