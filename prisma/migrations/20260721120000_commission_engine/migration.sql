-- Commission engine (layer 2): effective-dated rate table, attribution join, materialised ledger.
-- Built dormant; all rules proven synthetically against a fixed clock.

CREATE TABLE "CommissionRate" (
    "id" TEXT NOT NULL,
    "country_code" TEXT NOT NULL,
    "currency" TEXT NOT NULL,
    "tier" TEXT NOT NULL,
    "effective_from" TIMESTAMP(3) NOT NULL,
    "amount_pennies" INTEGER NOT NULL,
    "created_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CommissionRate_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "TenantAttribution" (
    "id" TEXT NOT NULL,
    "group_id" TEXT NOT NULL,
    "party_type" TEXT NOT NULL,
    "party_id" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "share_bp" INTEGER NOT NULL,
    "effective_from" TIMESTAMP(3) NOT NULL,
    "ended_at" TIMESTAMP(3),
    "source" TEXT NOT NULL,
    "created_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "TenantAttribution_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "CommissionEntry" (
    "id" TEXT NOT NULL,
    "group_id" TEXT NOT NULL,
    "party_type" TEXT NOT NULL,
    "party_id" TEXT NOT NULL,
    "period" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "tier" TEXT NOT NULL,
    "rate_id" TEXT NOT NULL,
    "share_bp" INTEGER NOT NULL,
    "amount_pennies" INTEGER NOT NULL,
    "currency" TEXT NOT NULL,
    "source_ref" TEXT NOT NULL,
    "payment_ref" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "payout_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CommissionEntry_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "CommissionRate_country_code_currency_tier_effective_from_idx" ON "CommissionRate"("country_code", "currency", "tier", "effective_from");
CREATE INDEX "TenantAttribution_group_id_idx" ON "TenantAttribution"("group_id");
CREATE INDEX "TenantAttribution_party_type_party_id_idx" ON "TenantAttribution"("party_type", "party_id");
CREATE UNIQUE INDEX "CommissionEntry_source_ref_party_id_kind_key" ON "CommissionEntry"("source_ref", "party_id", "kind");
CREATE INDEX "CommissionEntry_group_id_period_idx" ON "CommissionEntry"("group_id", "period");
CREATE INDEX "CommissionEntry_party_id_status_idx" ON "CommissionEntry"("party_id", "status");
CREATE INDEX "CommissionEntry_payment_ref_idx" ON "CommissionEntry"("payment_ref");
