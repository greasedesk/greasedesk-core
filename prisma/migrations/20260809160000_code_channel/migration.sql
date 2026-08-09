-- Which channel a verification code actually travelled on. NULLable and backfilled to NULL: every
-- row that predates this column was an SMS (the email fallback ships in the same commit), and
-- lib/delivered-code reads a NULL as 'sms'. Additive, no default, no rewrite.
ALTER TABLE "DeliveredCode" ADD COLUMN "channel" TEXT;
