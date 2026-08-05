-- The operator's note explaining a revised quote. Additive only, nullable — an existing version
-- has no note and must stay valid.
ALTER TABLE "QuoteVersion" ADD COLUMN "note" TEXT;
