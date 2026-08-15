-- SMS top-ups: an append-only record of packs bought, never a balance.
-- What has been USED is already recorded as NotificationLog rows, so the remaining allowance is
-- derived (lib/sms-allowance) rather than stored. A decrement-on-send counter would be a second
-- opinion on a figure the log already answers.
CREATE TABLE "SmsTopUp" (
  "id"             TEXT NOT NULL,
  "group_id"       TEXT NOT NULL,
  "quantity"       INTEGER NOT NULL,
  "amount_pennies" INTEGER,
  "source_ref"     TEXT,
  "granted_by"     TEXT,
  "note"           TEXT,
  "created_at"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "SmsTopUp_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "SmsTopUp_source_ref_key" ON "SmsTopUp"("source_ref");
CREATE INDEX "SmsTopUp_group_id_created_at_idx" ON "SmsTopUp"("group_id", "created_at");
ALTER TABLE "SmsTopUp" ADD CONSTRAINT "SmsTopUp_group_id_fkey"
  FOREIGN KEY ("group_id") REFERENCES "Group"("id") ON DELETE CASCADE ON UPDATE CASCADE;
