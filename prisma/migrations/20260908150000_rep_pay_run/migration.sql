-- SALES COMMISSION PAY RUNS. Released by a person, closed by a person, immutable after.
--
-- Hand-written, applied with `migrate deploy`. `migrate dev` proposes a RESET here.
--
-- LANGUAGE: this is Sales Commission. A rep is self-employed and invoices us for it. Never wage,
-- never salary, and never "pay" as a noun for the rep — which is why payout_id is renamed below.

-- ── THE RUN ────────────────────────────────────────────────────────────────────────────────────
CREATE TABLE "RepPayRun" (
    "id"                      TEXT NOT NULL,
    "period"                  TEXT NOT NULL,
    "scheduled_on"            TIMESTAMP(3) NOT NULL,
    "status"                  TEXT NOT NULL,
    "opened_at"               TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "opened_by"               TEXT,
    "closed_at"               TIMESTAMP(3),
    "closed_by"               TEXT,
    "signoff"                 TEXT,
    "snapshot_parties"        INTEGER,
    "snapshot_line_count"     INTEGER,
    "snapshot_amount_pennies" INTEGER,

    CONSTRAINT "RepPayRun_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "RepPayRun_status_scheduled_on_idx" ON "RepPayRun"("status", "scheduled_on");

ALTER TABLE "RepPayRun" ADD CONSTRAINT "RepPayRun_status_chk" CHECK (status IN ('open', 'closed'));

-- ONE OPEN RUN, PLATFORM-WIDE, ENFORCED BY THE DATABASE. A partial unique index on the open status:
-- every open row has status = 'open', so uniqueness on that column among open rows means exactly
-- one can exist. Application logic would be a rule the second writer skips.
CREATE UNIQUE INDEX "RepPayRun_one_open_key" ON "RepPayRun"("status") WHERE "status" = 'open';

-- CLOSED IS ALL FOUR OR NONE. A closed run cannot be missing its signoff, and an open one cannot
-- carry a stale one. The signoff must be non-blank: a run closed with no words is a payment nobody
-- explained, and btrim is here rather than left to a form.
ALTER TABLE "RepPayRun" ADD CONSTRAINT "RepPayRun_closure_chk" CHECK (
       (status = 'open'   AND closed_at IS NULL AND closed_by IS NULL AND signoff IS NULL
                          AND snapshot_parties IS NULL AND snapshot_line_count IS NULL
                          AND snapshot_amount_pennies IS NULL)
    OR (status = 'closed' AND closed_at IS NOT NULL AND closed_by IS NOT NULL
                          AND signoff IS NOT NULL AND btrim(signoff) <> ''
                          AND snapshot_parties IS NOT NULL AND snapshot_line_count IS NOT NULL
                          AND snapshot_amount_pennies IS NOT NULL)
);

-- ── THE LINE ───────────────────────────────────────────────────────────────────────────────────
-- payout_id → pay_run_id. It had no writer and no rows, so the window to rename was open; after a
-- release exists this would be a rename over money already released.
ALTER TABLE "CommissionEntry" RENAME COLUMN "payout_id" TO "pay_run_id";
ALTER TABLE "CommissionEntry" ADD COLUMN "held_reason" TEXT;
ALTER TABLE "CommissionEntry" ADD COLUMN "release_override_reason" TEXT;
ALTER TABLE "CommissionEntry" ADD COLUMN "released_at" TIMESTAMP(3);
ALTER TABLE "CommissionEntry" ADD COLUMN "released_by" TEXT;

CREATE INDEX "CommissionEntry_pay_run_id_idx" ON "CommissionEntry"("pay_run_id");
-- RESTRICT, not CASCADE: deleting a run that holds released lines would delete the record of money
-- somebody approved. A closed run is not deletable at all, and an open one must be emptied first.
ALTER TABLE "CommissionEntry" ADD CONSTRAINT "CommissionEntry_pay_run_id_fkey"
    FOREIGN KEY ("pay_run_id") REFERENCES "RepPayRun"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "CommissionEntry" ADD CONSTRAINT "CommissionEntry_status_chk" CHECK (
  status IN ('pending', 'held', 'released', 'billed', 'paid', 'void')
);

-- HELD IS THE REASON. Paired exactly, so a released line cannot carry a stale hold reason and a
-- held line cannot carry none. The reason is a CODE — the sentence lives in CommissionEntryNote.
ALTER TABLE "CommissionEntry" ADD CONSTRAINT "CommissionEntry_hold_chk" CHECK (
  (status = 'held') = (held_reason IS NOT NULL)
);
ALTER TABLE "CommissionEntry" ADD CONSTRAINT "CommissionEntry_hold_reason_chk" CHECK (
  held_reason IS NULL OR held_reason = ANY (ARRAY[
    'no_visit_recorded'::text,
    'outside_visit_window'::text,
    'evidence_queried'::text,
    'awaiting_rep_response'::text
  ])
);

-- AN OVERRIDE IS A CODE TOO, and there is no 'other': the prose that would explain one is in the
-- note row, and a set that cannot express a case is WRONG rather than quietly extended.
ALTER TABLE "CommissionEntry" ADD CONSTRAINT "CommissionEntry_override_chk" CHECK (
  release_override_reason IS NULL OR release_override_reason = ANY (ARRAY[
    'visit_confirmed_offline'::text,
    'system_prevented_the_scan'::text,
    'garage_onboarding_month'::text
  ])
);

-- A RELEASED LINE HAS ALL THREE, AND AN UNRELEASED ONE HAS NONE. `void` is exempt on purpose: it is
-- terminal from ANY state, so a line voided after release keeps the run it was released into — a
-- closed run never moves again, and removing the line would be moving it.
ALTER TABLE "CommissionEntry" ADD CONSTRAINT "CommissionEntry_release_chk" CHECK (
       (status IN ('released', 'billed', 'paid')
          AND pay_run_id IS NOT NULL AND released_at IS NOT NULL AND released_by IS NOT NULL)
    OR (status IN ('pending', 'held')
          AND pay_run_id IS NULL AND released_at IS NULL AND released_by IS NULL)
    OR status = 'void'
);

-- ── THE SENTENCE BESIDE THE CODE ───────────────────────────────────────────────────────────────
CREATE TABLE "CommissionEntryNote" (
    "id"         TEXT NOT NULL,
    "entry_id"   TEXT NOT NULL,
    "kind"       TEXT NOT NULL,
    "body"       TEXT NOT NULL,
    "written_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CommissionEntryNote_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "CommissionEntryNote_entry_id_idx" ON "CommissionEntryNote"("entry_id");
ALTER TABLE "CommissionEntryNote" ADD CONSTRAINT "CommissionEntryNote_entry_id_fkey"
    FOREIGN KEY ("entry_id") REFERENCES "CommissionEntry"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CommissionEntryNote" ADD CONSTRAINT "CommissionEntryNote_kind_chk" CHECK (
  kind IN ('hold', 'release_override')
);
-- A note row that exists with nothing in it is a row nobody meant to write.
ALTER TABLE "CommissionEntryNote" ADD CONSTRAINT "CommissionEntryNote_body_chk" CHECK (btrim(body) <> '');
