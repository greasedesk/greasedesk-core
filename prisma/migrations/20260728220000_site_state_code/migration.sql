-- US-only structured subdivision on Site (USPS code). Drives timezone derivation at onboarding
-- and is the future sales-tax jurisdiction hook. NULL elsewhere (honest-null).
ALTER TABLE "Site" ADD COLUMN "state_code" TEXT;
