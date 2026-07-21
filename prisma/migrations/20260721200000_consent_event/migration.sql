-- Cookie-consent audit trail. Anonymous, versioned: one row per choice, same consent_id across changes.
CREATE TABLE "ConsentEvent" (
    "id" TEXT NOT NULL,
    "consent_id" TEXT NOT NULL,
    "policy_version" TEXT NOT NULL,
    "region" TEXT NOT NULL,
    "functional" BOOLEAN NOT NULL,
    "analytics" BOOLEAN NOT NULL,
    "marketing" BOOLEAN NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ConsentEvent_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "ConsentEvent_consent_id_idx" ON "ConsentEvent"("consent_id");
CREATE INDEX "ConsentEvent_created_at_idx" ON "ConsentEvent"("created_at");
