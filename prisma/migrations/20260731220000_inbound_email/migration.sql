-- INBOUND EMAIL.
--
-- Tokens are RANDOM AND ROTATABLE, and deliberately not derived from anything else: `ref` is
-- sequentially allocated (GB-GD2141, 2175, 2176 … enumerable), and `id` is unguessable but
-- unrotatable — a leaked address would be unfixable without changing a primary key.
ALTER TABLE "Group"         ADD COLUMN "inbound_token" TEXT;
CREATE UNIQUE INDEX "Group_inbound_token_key" ON "Group"("inbound_token");

ALTER TABLE "MessageThread" ADD COLUMN "thread_token" TEXT;
CREATE UNIQUE INDEX "MessageThread_thread_token_key" ON "MessageThread"("thread_token");

-- Derived in touchThread from the log, never authored. 'in' is what "unresponded" means.
ALTER TABLE "MessageThread" ADD COLUMN "last_message_direction" TEXT;
-- Clearing unread is an act by a person; it is attributed like one.
ALTER TABLE "MessageThread" ADD COLUMN "last_read_at" TIMESTAMP(3);
ALTER TABLE "MessageThread" ADD COLUMN "last_read_by" TEXT;

-- Direction was derived-and-always-outbound while nothing could arrive. Now it varies, so it is a
-- field. DEFAULT 'out' keeps every historical row's meaning correct without a data migration.
ALTER TABLE "NotificationLog" ADD COLUMN "direction" TEXT NOT NULL DEFAULT 'out';
-- received_at, not sent_at: we did not send it, and copying a timestamp into sent_at would claim we did.
ALTER TABLE "NotificationLog" ADD COLUMN "received_at" TIMESTAMP(3);
-- WE keep the body. Resend discards received mail after 30 days; after that this row is the only copy.
ALTER TABLE "NotificationLog" ADD COLUMN "body_html" TEXT;
CREATE INDEX "NotificationLog_direction_thread_id_idx" ON "NotificationLog"("direction", "thread_id");

-- Dedupe ledger, same shape as StripeEvent: written FIRST so a replay collides on insert.
-- Keyed on the Svix DELIVERY id, never the payload's sender-controlled RFC message_id.
CREATE TABLE "InboundEvent" (
  "svix_id"      TEXT NOT NULL,
  "type"         TEXT NOT NULL,
  "email_id"     TEXT,
  "processed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "InboundEvent_pkey" PRIMARY KEY ("svix_id")
);

-- An inbound message is not sent, failed or skipped — none of the outbound statuses describe a
-- message that came the other way.
ALTER TYPE "NotificationStatus" ADD VALUE IF NOT EXISTS 'received';
