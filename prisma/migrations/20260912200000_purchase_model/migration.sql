-- @migration: additive
--
-- THE PURCHASE MODEL. One new table, its own CHECKs declared inside the CREATE TABLE, and two
-- non-unique indexes. Nothing here constrains a write that production already makes.
--
-- ── NO PARTIAL UNIQUE INDEX, NO TRIGGER, AND THAT IS WHY THIS IS ONE PUSH ───────────────────────
-- The clock session needed both (one open session per tech; a recorded time never edited) and paid a
-- two-push cycle for them. This needs neither: there is no one-open invariant, and FREEZE-AT-ISSUE
-- DOES NOT APPLY — a model is meant to be changed. An append-only trigger added here later by
-- analogy with the invoice or the clock session would be a mistake, and would also turn every future
-- migration on this table into a constraining one.
--
-- ── AND NO CHECK ON `status`, DELIBERATELY ──────────────────────────────────────────────────────
-- The house rule is that a vocabulary lives in the database, and this is a considered exception. The
-- column exists so a later stock slice has room for 'bought' or 'sold'; a CHECK would make adding one
-- an ALTER TABLE DROP/ADD CONSTRAINT, i.e. constraining, i.e. the two-push cycle the room was meant
-- to avoid. The vocabulary is in lib/purchase-model and purchase-model-gate asserts the writer only
-- writes from it.
CREATE TABLE "PurchaseModel" (
    "id"                  TEXT NOT NULL,
    "group_id"            TEXT NOT NULL,
    "created_by_user_id"  TEXT NOT NULL,
    "label"               TEXT NOT NULL,
    "vehicle_ident"       TEXT,
    -- NO FOREIGN KEY, on purpose: stock does not exist. Adding the constraint is the only migration
    -- a stock slice needs, and it can be a constraining one on its own rather than inside a feature.
    "vehicle_id"          TEXT,
    "status"              TEXT NOT NULL DEFAULT 'modelled',
    "inputs"              JSONB NOT NULL,
    "purchase_pence"      INTEGER NOT NULL,
    "sale_pence"          INTEGER NOT NULL,
    "vat_status"          TEXT NOT NULL,
    "profit_pence"        INTEGER NOT NULL,
    "created_at"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"          TIMESTAMP(3) NOT NULL,
    CONSTRAINT "PurchaseModel_pkey" PRIMARY KEY ("id"),
    -- The toggle that changes the answer by four figures. A vocabulary that WILL NOT grow, so unlike
    -- `status` it belongs in the database: there is no third VAT treatment waiting to be added.
    CONSTRAINT "PurchaseModel_vat_status_chk" CHECK ("vat_status" IN ('margin', 'qualifying')),
    -- A model of a car nobody would buy or sell is not a model. Negative money is a typo, not a case.
    CONSTRAINT "PurchaseModel_amounts_chk" CHECK ("purchase_pence" >= 0 AND "sale_pence" >= 0),
    CONSTRAINT "PurchaseModel_label_chk" CHECK (length(btrim("label")) > 0 AND length("label") <= 120),
    CONSTRAINT "PurchaseModel_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "Group"("id") ON DELETE CASCADE
);

CREATE INDEX "PurchaseModel_group_id_updated_at_idx" ON "PurchaseModel"("group_id", "updated_at");
