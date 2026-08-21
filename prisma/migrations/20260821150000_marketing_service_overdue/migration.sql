-- A car PAST its service mileage was landing in Warm beside one due in three weeks: effectiveDueDate
-- computed `alreadyPassed` and serviceDue dropped it. Splitting the reason mirrors the MOT pair that
-- was already right — mot_expired is Hot, mot_due is Warm.
ALTER TABLE "MarketingContact" DROP CONSTRAINT "MarketingContact_reason_check";
ALTER TABLE "MarketingContact" ADD CONSTRAINT "MarketingContact_reason_check"
  CHECK ("reason" IN (
    'mot_expired', 'battery_replace', 'tyre_illegal', 'agreed_not_booked', 'service_overdue',
    'mot_due', 'service_due', 'unanswered', 'battery_retest',
    'declined', 'snoozed', 'distant'
  ));
