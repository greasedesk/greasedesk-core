-- quote_expired joins the lead reasons a contact can be recorded against.
--
-- THE LIST AND THE CONSTRAINT ARE TWO DIFFERENT THINGS. Adding a kind in TypeScript and not here
-- gives a board that shows a reason nobody can then record against, and the failure arrives at the
-- moment a garage rings the customer — the worst possible place to find it. marketing-board-gate
-- compares LEAD_REASON_KINDS against this constraint, kind for kind, and went red at 14 vs 13.
--
-- Rebuilt rather than extended: a CHECK has no ADD VALUE, so the whole list is restated. No data
-- migration — no row can already hold a value the old constraint refused.
ALTER TABLE "MarketingContact" DROP CONSTRAINT "MarketingContact_reason_check";
ALTER TABLE "MarketingContact" ADD CONSTRAINT "MarketingContact_reason_check" CHECK (reason = ANY (ARRAY[
  'mot_expired'::text, 'battery_replace'::text, 'tyre_illegal'::text, 'agreed_not_booked'::text,
  'service_overdue'::text, 'wants_call'::text, 'quote_expired'::text, 'mot_due'::text,
  'service_due'::text, 'unanswered'::text, 'battery_retest'::text, 'declined'::text,
  'snoozed'::text, 'distant'::text
]));
