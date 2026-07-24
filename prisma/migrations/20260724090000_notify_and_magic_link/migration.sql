-- Slice 1 A+B: notification layer + magic-link customer auth. Purely additive.

CREATE TYPE "NotificationChannel" AS ENUM ('email', 'sms');
CREATE TYPE "NotificationStatus"  AS ENUM ('queued', 'sent', 'failed', 'delivered', 'bounced', 'skipped');
CREATE TYPE "MagicLinkPurpose"    AS ENUM ('quote_view', 'portal_view');

CREATE TABLE "NotificationLog" (
    "id"                  TEXT NOT NULL,
    "group_id"            TEXT,
    "channel"             "NotificationChannel" NOT NULL,
    "template"            TEXT NOT NULL,
    "provider"            TEXT NOT NULL,
    "status"              "NotificationStatus" NOT NULL DEFAULT 'queued',
    "recipient"           TEXT NOT NULL,
    "subject"             TEXT,
    "provider_message_id" TEXT,
    "error"               TEXT,
    "subject_type"        TEXT,
    "subject_id"          TEXT,
    "created_at"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sent_at"             TIMESTAMP(3),
    CONSTRAINT "NotificationLog_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "NotificationLog_group_id_created_at_idx"      ON "NotificationLog"("group_id", "created_at");
CREATE INDEX "NotificationLog_provider_message_id_idx"      ON "NotificationLog"("provider_message_id");
CREATE INDEX "NotificationLog_subject_type_subject_id_idx"  ON "NotificationLog"("subject_type", "subject_id");

ALTER TABLE "NotificationLog" ADD CONSTRAINT "NotificationLog_group_id_fkey"
    FOREIGN KEY ("group_id") REFERENCES "Group"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "CustomerMagicLink" (
    "id"              TEXT NOT NULL,
    "group_id"        TEXT NOT NULL,
    "job_card_id"     TEXT NOT NULL,
    "purpose"         "MagicLinkPurpose" NOT NULL,
    "token_hash"      TEXT NOT NULL,
    "expires_at"      TIMESTAMP(3) NOT NULL,
    "revoked_at"      TIMESTAMP(3),
    "recipient"       TEXT NOT NULL,
    "consumed_at"     TIMESTAMP(3),
    "last_used_at"    TIMESTAMP(3),
    "use_count"       INTEGER NOT NULL DEFAULT 0,
    "created_at"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by_user" TEXT,
    CONSTRAINT "CustomerMagicLink_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "CustomerMagicLink_token_hash_key"           ON "CustomerMagicLink"("token_hash");
CREATE INDEX "CustomerMagicLink_group_id_job_card_id_idx"        ON "CustomerMagicLink"("group_id", "job_card_id");
CREATE INDEX "CustomerMagicLink_expires_at_idx"                  ON "CustomerMagicLink"("expires_at");

ALTER TABLE "CustomerMagicLink" ADD CONSTRAINT "CustomerMagicLink_group_id_fkey"
    FOREIGN KEY ("group_id") REFERENCES "Group"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CustomerMagicLink" ADD CONSTRAINT "CustomerMagicLink_job_card_id_fkey"
    FOREIGN KEY ("job_card_id") REFERENCES "JobCard"("id") ON DELETE CASCADE ON UPDATE CASCADE;
