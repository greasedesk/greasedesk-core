-- ADDITIVE ONLY. Every existing TwoFactorSecret row is a TOTP enrolment, so the method default
-- backfills them correctly and `secret` keeps its value; dropping the NOT NULL widens what the
-- column accepts without changing anything already in it.
ALTER TABLE "TwoFactorSecret" ADD COLUMN "method" TEXT NOT NULL DEFAULT 'totp';
ALTER TABLE "TwoFactorSecret" ALTER COLUMN "secret" DROP NOT NULL;
ALTER TABLE "TwoFactorSecret" ADD COLUMN "phone_e164" TEXT;
ALTER TABLE "TwoFactorSecret" ADD COLUMN "phone_verified_at" TIMESTAMP(3);

-- One table for every delivered one-time code, kept apart by `purpose`.
CREATE TABLE "DeliveredCode" (
    "id" TEXT NOT NULL,
    "subject_type" TEXT NOT NULL,
    "subject_id" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "destination" TEXT NOT NULL,
    "code_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "consumed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "DeliveredCode_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "DeliveredCode_subject_type_subject_id_purpose_idx" ON "DeliveredCode"("subject_type", "subject_id", "purpose");
CREATE INDEX "DeliveredCode_expires_at_idx" ON "DeliveredCode"("expires_at");
