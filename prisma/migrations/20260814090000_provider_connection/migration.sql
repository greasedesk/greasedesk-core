-- ProviderConnection: one row per (tenant, payment provider).
--
-- ADDITIVE + BACKFILL. The Group.stripe_* columns are NOT dropped: they become vestigial, and are
-- kept as the only record of the pre-migration state should the backfill ever need auditing.

CREATE TABLE "ProviderConnection" (
  "id"               TEXT NOT NULL,
  "group_id"         TEXT NOT NULL,
  "provider"         TEXT NOT NULL,
  "external_id"      TEXT,
  "livemode"         BOOLEAN,
  "charges_enabled"  BOOLEAN NOT NULL DEFAULT false,
  "payouts_enabled"  BOOLEAN NOT NULL DEFAULT false,
  "disabled_reason"  TEXT,
  "requirements_due" JSONB,
  "connected_at"     TIMESTAMP(3),
  "disconnected_at"  TIMESTAMP(3),
  "created_at"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"       TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ProviderConnection_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ProviderConnection_group_id_provider_key" ON "ProviderConnection"("group_id", "provider");
-- NULL external_ids do not collide in Postgres, so every unconnected tenant can hold a row.
CREATE UNIQUE INDEX "ProviderConnection_provider_external_id_key" ON "ProviderConnection"("provider", "external_id");
CREATE INDEX "ProviderConnection_provider_idx" ON "ProviderConnection"("provider");

ALTER TABLE "ProviderConnection"
  ADD CONSTRAINT "ProviderConnection_group_id_fkey"
  FOREIGN KEY ("group_id") REFERENCES "Group"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ── BACKFILL ────────────────────────────────────────────────────────────────────────────────────
-- Only tenants that actually have Stripe state. A tenant that never connected gets NO row, because
-- 'not_connected' is the absence of a connection, not a stored status — the same reason the state
-- is derived rather than kept in a column.
INSERT INTO "ProviderConnection" (
  "id", "group_id", "provider", "external_id", "livemode",
  "charges_enabled", "payouts_enabled", "disabled_reason", "requirements_due",
  "connected_at", "disconnected_at", "created_at", "updated_at"
)
SELECT
  gen_random_uuid()::text,
  g."id",
  'stripe',
  g."stripe_account_id",
  g."stripe_account_livemode",
  COALESCE(g."stripe_charges_enabled", false),
  COALESCE(g."stripe_payouts_enabled", false),
  g."stripe_disabled_reason",
  g."stripe_requirements_due",
  g."stripe_connected_at",
  g."stripe_disconnected_at",
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
FROM "Group" g
WHERE g."stripe_account_id" IS NOT NULL
   OR g."stripe_disconnected_at" IS NOT NULL;
