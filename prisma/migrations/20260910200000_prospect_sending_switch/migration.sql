-- THE PROSPECT SENDING SWITCH — whether GreaseDesk's follow-up emails actually go out.
--
-- Hand-written, applied with `migrate deploy`.
--
-- ── NO ROW MEANS OFF ───────────────────────────────────────────────────────────────────────────
-- The switch defaults OFF because the sequence copy is placeholder text until the owner writes it.
-- Absence is the default rather than a seeded `false`, so "never switched on" is a state the table can
-- express instead of a value somebody wrote once and nobody can date.
--
-- ── IT STOPS THE SEND, NOT THE ENROLMENT ───────────────────────────────────────────────────────
-- A prospect recorded while this is off still enrols and still starts at step 1 when it is turned on.
-- They are QUEUED, not skipped — and "queued" is DERIVED from this row plus the sequence, never stored,
-- so turning the switch on or off never has to rewrite a row per prospect.
--
-- ── ONE ROW, BY CONSTRUCTION ───────────────────────────────────────────────────────────────────
-- The id is pinned by a CHECK, so two switches that disagree cannot exist. History — who turned it on,
-- when — is in SuperAdminAudit; this row is only the current decision and its author.
CREATE TABLE "ProspectSending" (
    "id"         TEXT NOT NULL,
    "enabled"    BOOLEAN NOT NULL,
    "changed_at" TIMESTAMP(3) NOT NULL,
    "changed_by" TEXT NOT NULL,

    CONSTRAINT "ProspectSending_pkey" PRIMARY KEY ("id")
);
ALTER TABLE "ProspectSending" ADD CONSTRAINT "ProspectSending_singleton_chk" CHECK (id = 'prospect_sending');
