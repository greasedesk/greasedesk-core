-- A CONFIRMATION, NOT A CAPTURE.
--
-- `diag_scan` shipped with a switch, a label, a skip flow and a line in the manager's escalation —
-- and no writer at all. Its done-rule asked for a JobCardPhoto with slot 'diag_scan'; nothing in
-- the codebase ever wrote that slot, on any surface, and there are 0 such rows across every tenant.
-- On a site with the prompt on, the item could only ever be skipped.
--
-- The scan runs on an external tool and its report is emailed elsewhere, so there is no artefact
-- for us to hold — asking for one was the mistake. These two columns are the same shape as
-- intake_nothing_found_at/_by: the affirmative, with an author, undoable.
--
-- NO BACKFILL. A card nobody ticked was not scanned as far as we know, and inventing a timestamp
-- would assert a check that nobody performed.
ALTER TABLE "JobCard" ADD COLUMN "diag_scan_at" TIMESTAMP(3);
ALTER TABLE "JobCard" ADD COLUMN "diag_scan_by" TEXT;
