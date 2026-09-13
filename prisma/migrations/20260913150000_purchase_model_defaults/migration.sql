-- @migration: additive
--
-- WHAT THIS GARAGE'S SUPPLIERS DO, REMEMBERED. One row per group, seeding the per-model answers so a
-- garage is not asked on every car whether its paint shop is VAT registered.
--
-- ── ADDITIVE, AND THEREFORE ONE PUSH ────────────────────────────────────────────────────────────
-- A CREATE TABLE constrains no write that production already makes: nothing deployed writes this table,
-- and nothing reads it. The foreign key binds only rows created after it exists. No column is added to
-- an existing table, no CHECK is placed on one, and no index is made unique.
--
-- ── PRIMARY KEY IS THE GROUP, NOT A UUID ────────────────────────────────────────────────────────
-- One row per tenant by construction. A surrogate id would allow two rows and then need a partial
-- unique index to forbid them — which IS a constraining migration, and a second push, for a table whose
-- whole shape is "the answer for this garage".
--
-- ── NO CHECK ON cost_vat ────────────────────────────────────────────────────────────────────────
-- The vocabulary lives in lib/purchase-model (VAT_TREATMENTS) and the reader ignores anything it does
-- not recognise, so a value written by a newer deploy cannot break an older one. A CHECK here would
-- make adding a fourth treatment a DROP/ADD CONSTRAINT — constraining, and a two-push cycle — for a
-- list that is expected to grow.
CREATE TABLE "PurchaseModelDefaults" (
    "group_id"           TEXT NOT NULL,
    "cost_vat"           JSONB NOT NULL,
    "updated_at"         TIMESTAMP(3) NOT NULL,
    "updated_by_user_id" TEXT NOT NULL,
    CONSTRAINT "PurchaseModelDefaults_pkey" PRIMARY KEY ("group_id"),
    CONSTRAINT "PurchaseModelDefaults_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "Group"("id") ON DELETE CASCADE ON UPDATE NO ACTION
);
