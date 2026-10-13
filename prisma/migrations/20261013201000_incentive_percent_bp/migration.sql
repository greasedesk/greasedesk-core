-- @migration: additive
--
-- percent_off's basis points, on both option tables. Nullable, nothing deployed writes it.
--
-- WHY A COLUMN AT ALL, when the pennies are the promise: the percentage is the WORDING ("10% off")
-- and the re-editable authoring input. Without it the page could only say "£12.40 off", and an
-- owner reopening the option would find the percentage they typed gone. It is never used to
-- recompute the pennies — that resolution happens once, at freeze, per line.
-- AlterTable
ALTER TABLE "QuoteOption" ADD COLUMN     "incentive_percent_bp" INTEGER;

-- AlterTable
ALTER TABLE "QuoteOptionDraft" ADD COLUMN     "incentive_percent_bp" INTEGER;

