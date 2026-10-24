-- @migration: constraining it INSERTs rows, which the classifier does not recognise and therefore fails closed on — correctly, since a data write is the one shape it cannot reason about
-- @precedes-deploy: TenantPlanTerms was created minutes ago and NO deployed code reads or writes it, so nothing in production can see these rows or be constrained by them; the next deploy depends on every garage having one, because the readers it adds assume one shape for every garage
--
-- Every existing garage gets a TenantPlanTerms row, so there is ONE shape for every garage and no
-- reader has to handle the absence (owner, 2026-10-24).
--
-- ── 60, NOT 30, AND IT IS A CLAIM RATHER THAN A DERIVATION ────────────────────────────────────
-- The policy in force when every one of these garages signed up was a 60-day trial. Today's
-- setting is 30, and writing 30 here would rewrite what they were offered.
--
-- It is NOT derived from trial_ends_at, which was the obvious thing and is wrong: of 7 groups, 3
-- have no trial_ends_at at all and 3 have over 400 days. Those are comped or extended dates — a
-- fact about trial_ends_at, not a term anybody agreed — and deriving from them would invent four
-- trial policies that never existed.
--
-- THIS CHANGES NOBODY'S ACTUAL TRIAL END DATE. Group.trial_ends_at is untouched; this records the
-- terms they signed up under, which is a different question from when their trial runs out.
--
-- `plan = 'monthly'` is safe: monthly is the only plan that has ever existed.
--
-- IDEMPOTENT by the NOT EXISTS, so a re-run adds nothing — and it writes only for groups that have
-- no row, so it can never overwrite a term a garage actually agreed to.
INSERT INTO "TenantPlanTerms" (id, group_id, plan, trial_days, signed_up_at)
SELECT gen_random_uuid(), g.id, 'monthly', 60, g.created_at
  FROM "Group" g
 WHERE NOT EXISTS (SELECT 1 FROM "TenantPlanTerms" t WHERE t.group_id = g.id);
