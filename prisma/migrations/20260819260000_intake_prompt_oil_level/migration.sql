-- The fifth intake prompt. Additive, default OFF like the other four: a garage that does not want
-- to be asked about oil level is not asked, and the escalation never names an item nobody was
-- prompted for.
--
-- No column for the LEVEL itself. It is recorded as an audit event (intake.oil_level), the same way
-- a skip is, so a correction leaves a trail instead of overwriting one — and because the reading is
-- only ever "the latest one on this card".
ALTER TABLE "Site" ADD COLUMN "intake_prompt_oil_level" BOOLEAN NOT NULL DEFAULT false;
