-- WHEN A SITE SAID NO THANKS to the intake-prompts offer. Additive, nullable.
--
-- A SITE FACT, not a browser dismissal. A prompt that reappears on the next device, for the next
-- mechanic, or after a cache clear is worse than never showing it: it teaches people that
-- dismissing things in this product does not work, and that lesson spreads to every other dismissal
-- we ever ship.
--
-- NULL = never dismissed. It is never cleared: turning prompts on and off again is a NEW decision
-- and the offer stays gone. The Settings panel is where that decision lives and can be revisited.
ALTER TABLE "Site" ADD COLUMN "intake_offer_dismissed_at" TIMESTAMP(3);
ALTER TABLE "Site" ADD COLUMN "intake_offer_dismissed_by" TEXT;
