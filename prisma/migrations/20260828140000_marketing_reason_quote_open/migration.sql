-- quote_open joins quote_expired: a LIVE or VERBAL quote is a lead too, and it is not an expired one.
--
-- One kind covered all four states for a day, because splitting meant a second constraint rebuild.
-- The cost showed up at the point that matters: a garage ringing about a quote sent yesterday had
-- the call recorded as `quote_expired`. The behaviour was right and the label was a lie, which is
-- the kind of wrong that survives — nothing looks broken, and the contact history quietly stops
-- meaning what it says.
--
-- Rebuilt rather than extended: a CHECK has no ADD VALUE. No data migration — no row can hold a
-- value the old constraint refused, and every existing `quote_expired` row was recorded against a
-- genuinely lapsed quote.
ALTER TABLE "MarketingContact" DROP CONSTRAINT "MarketingContact_reason_check";
ALTER TABLE "MarketingContact" ADD CONSTRAINT "MarketingContact_reason_check" CHECK (reason = ANY (ARRAY[
  'mot_expired'::text, 'battery_replace'::text, 'tyre_illegal'::text, 'agreed_not_booked'::text,
  'service_overdue'::text, 'wants_call'::text, 'quote_expired'::text, 'quote_open'::text,
  'mot_due'::text, 'service_due'::text, 'unanswered'::text, 'battery_retest'::text,
  'declined'::text, 'snoozed'::text, 'distant'::text
]));
