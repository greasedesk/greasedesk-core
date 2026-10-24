-- @migration: additive
--
-- Closing a job card as NO CHARGE, without spending an invoice number.
--
-- Some cards exist only to direct a mechanic and hold intake: a comeback, a courtesy car, an
-- inspection that did not convert. Until now the only way to FINISH a card was to invoice it, so
-- TMBS spent chargeable number 100003331 on a £0 document with no lines — a number out of a
-- gapless statutory series, consumed to close a card nobody was going to bill.
--
-- ADDITIVE in the strict sense: four nullable columns, one boolean with a default, one new enum,
-- and one new VALUE on an existing enum. No existing row changes and nothing deployed writes any
-- of it — the code that does is in the same push, behind a permission that defaults to off for
-- STANDARD and is enforced in pages/api/jobcard-status.
--
-- ── WHY ADD VALUE IS ALONE IN THIS FILE ───────────────────────────────────────────────────────
-- Postgres will not let a newly added enum value be USED in the transaction that adds it. Nothing
-- here writes 'no_charge', so this file is safe; a later migration that backfills or constrains on
-- it must be its own file, or it will fail at apply time with an error that reads like a typo.

-- CreateEnum
CREATE TYPE "NoChargeReason" AS ENUM ('comeback_rework', 'warranty', 'goodwill', 'internal', 'inspection_only', 'inspection_for_quote');

-- AlterEnum
ALTER TYPE "JobCardStatus" ADD VALUE 'no_charge';

-- AlterTable
ALTER TABLE "Group" ADD COLUMN     "perm_standard_no_charge" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "JobCard" ADD COLUMN     "no_charge_at" TIMESTAMP(3),
ADD COLUMN     "no_charge_by" TEXT,
ADD COLUMN     "no_charge_prior_status" "JobCardStatus",
ADD COLUMN     "no_charge_reason" "NoChargeReason";
