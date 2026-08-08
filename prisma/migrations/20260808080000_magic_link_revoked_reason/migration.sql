-- Additive and nullable, no backfill. Every existing revoked link keeps a NULL reason, and NULL is
-- the honest answer: we genuinely do not know why those were killed, so the customer page shows the
-- neutral sentence rather than inventing one. The previous single `revoked` bucket asserted "this
-- quote has been updated — ask for the current version" for every cause, which was false for an
-- invoiced job.
ALTER TABLE "CustomerMagicLink" ADD COLUMN "revoked_reason" TEXT;
