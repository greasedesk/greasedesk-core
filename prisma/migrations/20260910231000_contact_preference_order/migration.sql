-- A HISTORY NEEDS A TOTAL ORDER. Hand-written, applied with `migrate deploy`.
--
-- ContactPreferenceEvent.created_at is millisecond precision, and two changes to one customer's
-- preference can land in the same millisecond (a gate does exactly that; a race can). "The latest
-- event" then had no answer, and ordering by the uuid id would have picked one at random — which
-- the history cross-check in contact-preferences-gate, and the "set by whom" line the staff form
-- will show (step 6), both depend on. `seq` is assigned by the database in commit-independent
-- insertion order and is the only ordering either reads.
ALTER TABLE "ContactPreferenceEvent" ADD COLUMN "seq" BIGSERIAL NOT NULL;
CREATE UNIQUE INDEX "ContactPreferenceEvent_seq_key" ON "ContactPreferenceEvent"("seq");
