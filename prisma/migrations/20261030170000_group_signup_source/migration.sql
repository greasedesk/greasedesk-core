-- @migration: additive
--
-- HOW A GARAGE SAYS IT FOUND US, AND WHAT THE LINK SAID (owner's slice F, 2026-10-30).
--
-- Five nullable columns beside Group.signup_ref, which is where "who sent them" already lives:
--
--   heard_about        the answer to "How did you hear about us?" on /register. One of a set the
--                      marketing copy owns (lib/signup-source), or NULL.
--   heard_about_other  the free text behind "other". NULL unless they chose it.
--   utm_source         what the LINK said, captured on the first visit and carried in a cookie
--   utm_medium         under the same functional-consent rule as gd_ref. NULL = not recorded,
--   utm_campaign       which is also what a visitor who refused functional consent leaves behind.
--
-- NULL MEANS NOT RECORDED, AND THAT IS MOST ROWS. Every garage that signed up before today has
-- NULL in all five, and so will every future one that skips the question or refuses the cookie.
-- There is no backfill: inventing "direct" for a row that was never asked would turn an absence
-- into a claim, and the Engine Room's "Came via" panel says "not recorded" rather than "direct"
-- for exactly that reason.
--
-- ── WHY THERE IS NO CHECK ON heard_about, AND THAT IS THE ONE JUDGEMENT HERE ───────────────────
-- The schema holds enum-ish strings with CHECKs in eight other places, so the absence is
-- deliberate. This set is MARKETING COPY: "YouTube", "a supplier or tool van", "another garage" —
-- and the next one the owner wants to add is a sentence in a form, not a schema change. A CHECK
-- would make every wording change a constraining migration and two pushes. The set lives in
-- lib/signup-source, validated at the ONE writer (pages/api/auth/register-garage), which is also
-- the only thing that can write these columns: nothing else in the app touches them, and no
-- customer can type into them except through the "other" box.
--
-- ADDITIVE, so it applies at any time: five nullable columns on an existing table, no data
-- rewrite, nothing constrained, and nothing deployed writes them.

ALTER TABLE "Group" ADD COLUMN "heard_about"       TEXT;
ALTER TABLE "Group" ADD COLUMN "heard_about_other" TEXT;
ALTER TABLE "Group" ADD COLUMN "utm_source"        TEXT;
ALTER TABLE "Group" ADD COLUMN "utm_medium"        TEXT;
ALTER TABLE "Group" ADD COLUMN "utm_campaign"      TEXT;
