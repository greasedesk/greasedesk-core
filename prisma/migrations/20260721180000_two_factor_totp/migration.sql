-- Two-factor (TOTP) storage — generic, keyed by (subject_type, subject_id), not FK'd to one identity
-- table so the same mechanism extends to tenant Users / Reps later with no schema change.
CREATE TABLE "TwoFactorSecret" (
    "id" TEXT NOT NULL,
    "subject_type" TEXT NOT NULL,
    "subject_id" TEXT NOT NULL,
    "secret" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "confirmed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "TwoFactorSecret_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "TwoFactorSecret_subject_type_subject_id_key" ON "TwoFactorSecret"("subject_type", "subject_id");

CREATE TABLE "TwoFactorRecoveryCode" (
    "id" TEXT NOT NULL,
    "subject_type" TEXT NOT NULL,
    "subject_id" TEXT NOT NULL,
    "code_hash" TEXT NOT NULL,
    "used_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "TwoFactorRecoveryCode_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "TwoFactorRecoveryCode_subject_type_subject_id_idx" ON "TwoFactorRecoveryCode"("subject_type", "subject_id");
