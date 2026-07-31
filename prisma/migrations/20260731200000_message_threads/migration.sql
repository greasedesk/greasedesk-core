-- MESSAGE THREADS — an INDEX over NotificationLog, never a second log. No message body lives here.
--
-- Keyed on (group, customer, vehicle). Customer AND vehicle, not vehicle alone: ownership transfer
-- has never been performed in this codebase, so today the two are indistinguishable — but when
-- transfer is built, a new owner must not inherit the previous owner's conversation.
CREATE TABLE "MessageThread" (
  "id"              TEXT NOT NULL,
  "group_id"        TEXT NOT NULL,
  "customer_id"     TEXT NOT NULL,
  "vehicle_id"      TEXT NOT NULL,
  "last_message_at" TIMESTAMP(3),
  -- INBOUND messages not yet read. Structurally 0 until an inbound path exists; nothing increments it.
  "unread_count"    INTEGER NOT NULL DEFAULT 0,
  "state"           TEXT NOT NULL DEFAULT 'open',
  "created_at"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"      TIMESTAMP(3) NOT NULL,
  CONSTRAINT "MessageThread_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "MessageThread_group_id_customer_id_vehicle_id_key" ON "MessageThread"("group_id", "customer_id", "vehicle_id");
CREATE INDEX "MessageThread_group_id_state_last_message_at_idx" ON "MessageThread"("group_id", "state", "last_message_at");

ALTER TABLE "MessageThread" ADD CONSTRAINT "MessageThread_group_id_fkey"    FOREIGN KEY ("group_id")    REFERENCES "Group"("id")    ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "MessageThread" ADD CONSTRAINT "MessageThread_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "MessageThread" ADD CONSTRAINT "MessageThread_vehicle_id_fkey"  FOREIGN KEY ("vehicle_id")  REFERENCES "Vehicle"("id")  ON DELETE CASCADE ON UPDATE CASCADE;

-- NULLABLE on purpose: a staff invite or operator email is not a customer conversation. Null means
-- "not a customer thread", not "orphan". SetNull so losing a thread never destroys the message record.
ALTER TABLE "NotificationLog" ADD COLUMN "thread_id" TEXT;
CREATE INDEX "NotificationLog_thread_id_created_at_idx" ON "NotificationLog"("thread_id", "created_at");
ALTER TABLE "NotificationLog" ADD CONSTRAINT "NotificationLog_thread_id_fkey" FOREIGN KEY ("thread_id") REFERENCES "MessageThread"("id") ON DELETE SET NULL ON UPDATE CASCADE;
