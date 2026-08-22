-- `wants_call` becomes a lead reason: the one answer that literally means "ring me" produced no
-- reason at all. MarketingContact.reason is CHECK-constrained against exactly the pipeline's list,
-- so a reason the board can show but nobody can record against would fail at the moment a garage
-- rings the customer.
ALTER TABLE "MarketingContact" DROP CONSTRAINT "MarketingContact_reason_check";
ALTER TABLE "MarketingContact" ADD CONSTRAINT "MarketingContact_reason_check"
  CHECK ("reason" IN (
    'mot_expired', 'battery_replace', 'tyre_illegal', 'agreed_not_booked', 'service_overdue', 'wants_call',
    'mot_due', 'service_due', 'unanswered', 'battery_retest',
    'declined', 'snoozed', 'distant'
  ));
