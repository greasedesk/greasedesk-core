-- WHY A FINDING WAS CLOSED — typed, beside the words rather than instead of them.
--
-- closed_reason already existed and already carried good sentences: 'Retested and sound',
-- 'Re-checked and within range', 'No longer scheduled'. What it could not do is be BRANCHED ON,
-- and the outcomes genuinely diverge:
--
--   fixed             the garage did it on this visit. Belongs on the customer's document as work
--                     done — NOT as an advisory for something no longer true.
--   declined          the customer said no. Must never print as done. (customer_response already
--                     records this on the OPEN item; this is the closure that follows it.)
--   no_longer_applies superseded, re-checked, retracted, scheduled away. Silent.
--
-- NULLABLE, and the null is meaningful: every closure before today was written by a UI that sent
-- only the id, so 'we do not know why' is the truth for those rows and must stay sayable. A
-- backfill guessing 'fixed' would put words in a garage's mouth on a customer's invoice.
ALTER TABLE "VehicleDueItem" ADD COLUMN "closed_kind" TEXT;

ALTER TABLE "VehicleDueItem" ADD CONSTRAINT "VehicleDueItem_closed_kind_check"
  CHECK ("closed_kind" IS NULL OR "closed_kind" IN ('fixed', 'declined', 'no_longer_applies'));

-- A kind without a closure is nonsense; a closure without a kind is the back catalogue.
ALTER TABLE "VehicleDueItem" ADD CONSTRAINT "VehicleDueItem_closed_kind_needs_closure"
  CHECK ("closed_kind" IS NULL OR "closed_at" IS NOT NULL);

-- The work-done block reads (closed_job_card_id, closed_kind='fixed'), so index the pair.
CREATE INDEX "VehicleDueItem_closed_job_card_id_closed_kind_idx"
  ON "VehicleDueItem" ("closed_job_card_id", "closed_kind");
