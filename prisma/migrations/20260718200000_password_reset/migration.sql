-- Password reset (launch blocker: an ADMIN owner who forgets their password had no way back in).
-- reset_token_* is DELIBERATELY separate from invite_token_* — invites are single-use-and-dead,
-- resets are legitimately repeatable, and reuse would inherit the invite's "already used" semantics.
ALTER TABLE "User" ADD COLUMN "reset_token_hash" TEXT;
ALTER TABLE "User" ADD COLUMN "reset_token_expires" TIMESTAMP(3);
-- Session revocation floor: the JWT strategy makes cookies self-contained and unrevocable by row
-- deletion, so a stolen 90-day session would outlive a reset. Tokens issued before this instant die.
ALTER TABLE "User" ADD COLUMN "sessions_valid_from" TIMESTAMP(3);

-- Shared-state rate limiting (serverless has no usable in-memory state; no Redis in the stack).
CREATE TABLE "AuthRateLimit" (
  "id" TEXT NOT NULL,
  "key" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AuthRateLimit_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "AuthRateLimit_key_created_at_idx" ON "AuthRateLimit"("key", "created_at");
