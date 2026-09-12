-- @migration: constraining a partial unique index and an append-only trigger on a NEW table
--
-- FOREIGN KEY NAMES FOLLOW PRISMA'S CONVENTION (<Table>_<field>_fkey), and that is not cosmetic:
-- hand-picked names left `migrate diff` proposing five statements to rename them, so schema drift
-- was permanently non-empty and the gate that watches for real drift would have been red forever.
-- Caught by the wrapper's own post-apply drift check, seconds after the first apply.
--
-- TIME ON A JOB, MEASURED. Hand-written, applied with scripts/migrate-apply.mjs.
--
-- ── WHY THIS DECLARES ITSELF CONSTRAINING WHEN IT ARGUABLY IS NOT ───────────────────────────────
-- Every object here is on a table created in this same migration, so no deployed writer can violate
-- any of it — production cannot insert into a table it has never heard of. The classifier in
-- lib/migration-deploy-rules only extends that reasoning to constraints declared INSIDE a
-- CREATE TABLE; a separate CREATE UNIQUE INDEX or CREATE TRIGGER reads as constraining whatever
-- table it names.
--
-- The header agrees with the classifier deliberately (owner, 2026-09-12): the cost is one extra
-- push, and widening the classifier inside a slice that is not about migrations is exactly what the
-- classifier exists to prevent. THE CASE IS NOTED FOR LATER: "a unique index or trigger naming only
-- a table created in this migration" is decidable and would be a fair refinement, in its own slice.

CREATE TABLE "JobClockSession" (
    "id"                   TEXT NOT NULL,
    "group_id"             TEXT NOT NULL,
    "job_card_id"          TEXT NOT NULL,
    "user_id"              TEXT NOT NULL,
    "started_at"           TIMESTAMP(3) NOT NULL,
    "ended_at"             TIMESTAMP(3),
    "started_source"       TEXT NOT NULL,
    "ended_source"         TEXT,
    "device_started_at"    TIMESTAMP(3),
    "device_ended_at"      TIMESTAMP(3),
    "started_received_at"  TIMESTAMP(3) NOT NULL,
    "ended_received_at"    TIMESTAMP(3),
    "ended_cause"          TEXT,
    "corrects_id"          TEXT,
    "correction_reason"    TEXT,
    "corrected_by_user_id" TEXT,
    "created_at"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "JobClockSession_pkey" PRIMARY KEY ("id"),
    -- THE END IS ONE FACT WITH FOUR PARTS: all present, or all absent. A half-closed session would
    -- render as a duration with no idea how it ended.
    CONSTRAINT "JobClockSession_end_pair_chk" CHECK (
      ("ended_at" IS NULL) = ("ended_source" IS NULL)
      AND ("ended_at" IS NULL) = ("ended_received_at" IS NULL)
      AND ("ended_at" IS NULL) = ("ended_cause" IS NULL)),
    -- Time does not run backwards. A device claiming otherwise is clamped in the writer; this is the
    -- floor under that, for every caller including raw SQL.
    CONSTRAINT "JobClockSession_order_chk" CHECK ("ended_at" IS NULL OR "ended_at" >= "started_at"),
    -- lib/job-clock CLOCK_SOURCES / END_CAUSES. Vocabulary in the database, so a typo cannot be stored.
    CONSTRAINT "JobClockSession_started_source_chk" CHECK ("started_source" IN ('live', 'queued', 'correction')),
    CONSTRAINT "JobClockSession_ended_source_chk"   CHECK ("ended_source" IS NULL OR "ended_source" IN ('live', 'queued', 'correction')),
    CONSTRAINT "JobClockSession_ended_cause_chk"    CHECK ("ended_cause" IS NULL OR "ended_cause" IN ('tech', 'superseded', 'correction')),
    -- A CORRECTION ALWAYS NAMES WHO AND WHY. The trio moves together, and the reason is real text.
    CONSTRAINT "JobClockSession_correction_trio_chk" CHECK (
      ("corrects_id" IS NULL) = ("correction_reason" IS NULL)
      AND ("corrects_id" IS NULL) = ("corrected_by_user_id" IS NULL)),
    CONSTRAINT "JobClockSession_correction_reason_chk" CHECK (
      "correction_reason" IS NULL OR (length(btrim("correction_reason")) > 0 AND length("correction_reason") <= 500)),
    CONSTRAINT "JobClockSession_group_id_fkey"     FOREIGN KEY ("group_id") REFERENCES "Group"("id") ON DELETE CASCADE,
    CONSTRAINT "JobClockSession_job_card_id_fkey"  FOREIGN KEY ("job_card_id") REFERENCES "JobCard"("id") ON DELETE CASCADE,
    CONSTRAINT "JobClockSession_corrects_id_fkey"  FOREIGN KEY ("corrects_id") REFERENCES "JobClockSession"("id") ON DELETE RESTRICT
);

CREATE INDEX "JobClockSession_job_card_id_idx" ON "JobClockSession"("job_card_id");
CREATE INDEX "JobClockSession_group_id_user_id_idx" ON "JobClockSession"("group_id", "user_id");
CREATE INDEX "JobClockSession_corrects_id_idx" ON "JobClockSession"("corrects_id");

-- ── ONE OPEN SESSION PER TECH, ENFORCED BY THE DATABASE ─────────────────────────────────────────
-- A partial unique index on the open state, the shape RepPayRun_one_open_key already uses. This is
-- the BACKSTOP, not the mechanism: lib/job-clock-store clocks on with a count-checked conditional
-- update, so no code path ever CATCHES a P2002 — a caught unique violation poisons the surrounding
-- transaction (lib/commission's 2026-08-16 finding) and code that looks idempotent then is not.
-- The index makes the invariant true regardless of caller; the conditional update makes the writer
-- never rely on the violation happening.
CREATE UNIQUE INDEX "JobClockSession_one_open_per_user_key" ON "JobClockSession"("user_id") WHERE "ended_at" IS NULL;

-- ── A RECORDED TIME IS NEVER EDITED ─────────────────────────────────────────────────────────────
-- The ContactPreferenceEvent shape. Closing a session writes ended_at ONCE — completing a fact, not
-- revising one — so the trigger permits NULL → value and refuses everything else: no re-closing, no
-- moving a start, no rewriting how it arrived. A correction is a new row (corrects_id), never this.
CREATE OR REPLACE FUNCTION "JobClockSession_append_only_trg"() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."started_at" IS DISTINCT FROM OLD."started_at"
     OR NEW."started_source" IS DISTINCT FROM OLD."started_source"
     OR NEW."started_received_at" IS DISTINCT FROM OLD."started_received_at"
     OR NEW."device_started_at" IS DISTINCT FROM OLD."device_started_at"
     OR NEW."job_card_id" IS DISTINCT FROM OLD."job_card_id"
     OR NEW."user_id" IS DISTINCT FROM OLD."user_id" THEN
    RAISE EXCEPTION 'JobClockSession: a recorded time is never edited (a correction is a new row)';
  END IF;
  IF OLD."ended_at" IS NOT NULL AND (
       NEW."ended_at" IS DISTINCT FROM OLD."ended_at"
       OR NEW."ended_source" IS DISTINCT FROM OLD."ended_source"
       OR NEW."ended_cause" IS DISTINCT FROM OLD."ended_cause") THEN
    RAISE EXCEPTION 'JobClockSession: a closed session is closed (a correction is a new row)';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER "JobClockSession_append_only" BEFORE UPDATE ON "JobClockSession"
  FOR EACH ROW EXECUTE FUNCTION "JobClockSession_append_only_trg"();
