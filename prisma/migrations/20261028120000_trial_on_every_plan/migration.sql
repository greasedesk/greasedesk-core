-- @migration: constraining it drops the trial-XOR-pay-now CHECK and adds a plan-shaped one in its place; every row now in the table and every currently deployed writer satisfies the replacement, so nothing can breach it
-- @precedes-deploy: the new code writes annual TenantPlanTerms rows carrying BOTH a trial and a payment, which the OLD check forbids — so the old check must be gone before that code runs; applying it early is safe because the replacement is satisfied by the writers already deployed
--
-- EVERY GARAGE GETS THE TRIAL (owner, 2026-10-28). THIS REVERSES THE RULING OF 2026-10-24.
--
-- The constraint being dropped made the old rule physical: a plan carried a trial or took a
-- payment, never both, because "the trial IS the discount taken at the front" on annual. The
-- offer has changed. Every garage now gets the 30-day trial whatever plan it chooses, and is
-- charged its plan when the trial ends — so an annual garage gets thirteen months of service for
-- its first payment, deliberately.
--
-- ── WHAT REPLACES IT, AND WHY NOT NOTHING ────────────────────────────────────────────────────
-- Dropping the check and adding none would leave the table able to record a monthly plan that
-- took £750 at signup, or an annual one that names no term. The invariant that SURVIVES the
-- reversal is about the plan's shape rather than its trial: monthly is rolling, so it takes
-- nothing up front and names no months; every annual shape takes one payment for a stated number
-- of months. trial_days is deliberately unconstrained now — it is 30 on both shapes, and writing
-- a rule that says so would have to be relaxed again the first time a plan is sold without one.
--
-- ── WHY THIS IS SAFE TO APPLY BEFORE THE DEPLOY ──────────────────────────────────────────────
-- Every row in the table was written by writePlanTerms from planFor, which produces exactly two
-- shapes: monthly (no payment, no months) and annual (payment, months). Both satisfy the new
-- check. The DEPLOYED writer produces those same two shapes. So the window between applying this
-- and pushing the code cannot produce a violation — which is the thing that makes a constraining
-- migration dangerous on a shared database, and is absent here.

ALTER TABLE "TenantPlanTerms" DROP CONSTRAINT "TenantPlanTerms_trial_xor_paynow";

ALTER TABLE "TenantPlanTerms" ADD CONSTRAINT "TenantPlanTerms_shape_by_plan"
  CHECK ((plan =  'monthly' AND paid_now_pennies IS     NULL AND months_paid IS     NULL)
      OR (plan <> 'monthly' AND paid_now_pennies IS NOT NULL AND months_paid IS NOT NULL));
