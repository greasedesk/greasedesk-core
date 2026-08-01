-- WHY an inbound body is missing: provider status code + message.
-- Separate from `error`, which answers "why couldn't this be placed on a conversation". A body-fetch
-- failure is an independent axis and conflating the two would make the unresolved view report fetch
-- faults as resolution faults. The first real inbound message arrived with a null body and NOTHING
-- recording the reason — diagnosing it meant guessing. This column is that fix.
ALTER TABLE "NotificationLog" ADD COLUMN "body_error" TEXT;
