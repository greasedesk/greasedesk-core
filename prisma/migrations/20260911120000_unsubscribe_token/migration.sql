-- THE TENANT UNSUBSCRIBE LINK LIVES ON THE MESSAGE IT CAME IN. Hand-written, applied with `migrate deploy`.
--
-- Step 4 of the tenant unsubscribe (owner decision B). Every MARKETING EMAIL a garage sends carries a
-- one-click way out, and the token behind it is stored on that email's own NotificationLog row —
-- minted by lib/notify::sendNotification, the one place a message is rendered.
--
-- WHY ON THE SEND ROW, not a table of its own: following the link must answer exactly one question —
-- which garage, which channel, which address received THIS message — and the row already holds all
-- three. The history event it produces cites that same row (ContactPreferenceEvent.
-- notification_log_id), so "they unsubscribed from the MOT reminder of 3 September" is one join.
-- It never expires: an unsubscribe link must go on working in a months-old email.
--
-- NULL = no link was sent with this message: every service message (a quote, an invoice), every
-- text, every row written before this migration. The CHECK says a token exists only on an email and
-- only in the shape the sender mints (24 random bytes, base64url) — 192 bits, not guessable, so the
-- endpoint needs no rate limit to be safe from someone walking the space.
ALTER TABLE "NotificationLog" ADD COLUMN "unsubscribe_token" TEXT;
CREATE UNIQUE INDEX "NotificationLog_unsubscribe_token_key" ON "NotificationLog"("unsubscribe_token");
ALTER TABLE "NotificationLog" ADD CONSTRAINT "NotificationLog_unsubscribe_token_chk"
  CHECK (unsubscribe_token IS NULL OR (channel = 'email' AND unsubscribe_token ~ '^[A-Za-z0-9_-]{32}$'));
