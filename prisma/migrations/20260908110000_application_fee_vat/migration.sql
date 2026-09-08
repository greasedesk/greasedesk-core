-- WHAT WAS TRUE OF THE VAT WHEN THIS RATE PRICED A PAYMENT.
--
-- Hand-written, applied with `migrate deploy`. `migrate dev` proposes a RESET here.
--
-- ── WHY NOW, WITH NOTHING NEEDING IT ───────────────────────────────────────────────────────────
-- This table's own comment already gives the argument: min_fee_pennies and cap_fee_pennies are
-- present and null "because fee_rate_id is FROZEN, so adding a column afterwards is a migration
-- over money already charged". That reasoning was never applied to VAT — the one axis certain to
-- change. The treatment was settled on 2026-08-15 (lib/application-fee): the fee is a separate
-- taxable supply, standard-rated and EXCLUSIVE, ONCE WE ARE REGISTERED. We are not. Meanwhile TMBS
-- already carries ten payments with a frozen fee_rate_id, so "money already charged" stopped being
-- hypothetical in August.
--
-- ── WHAT THIS COLUMN DOES NOT SAY ──────────────────────────────────────────────────────────────
-- How the VAT is COLLECTED. Stripe's application_fee_amount is one integer, so at registration
-- either the deduction grosses up or the VAT is billed on a separate consolidated invoice. That is
-- a decision for registration day and it is NOT MADE. Neither option appears in the set below,
-- deliberately: a value for it here would answer the question by accident.

-- Added nullable, backfilled to the truth, then made mandatory — the only order that works on a
-- table that already has a row.
ALTER TABLE "ApplicationFeeRate" ADD COLUMN "vat_treatment" TEXT;

-- THE PRE-REGISTRATION TRUTH, not a guess about registration day. The one existing row is the GB/GBP
-- platform default of 25bp effective 2026-08-15, written when we were not registered and still are
-- not — so `not_registered` is what was true when it priced those ten payments.
UPDATE "ApplicationFeeRate" SET "vat_treatment" = 'not_registered' WHERE "vat_treatment" IS NULL;

-- NOT NULL and NO DEFAULT. A default would answer on the writer's behalf, which is exactly the
-- silent failure lib/due-items describes for a pre-selected response.
ALTER TABLE "ApplicationFeeRate" ALTER COLUMN "vat_treatment" SET NOT NULL;

ALTER TABLE "ApplicationFeeRate" ADD CONSTRAINT "ApplicationFeeRate_vat_chk" CHECK (
  vat_treatment = ANY (ARRAY['not_registered'::text, 'standard_exclusive'::text])
);
