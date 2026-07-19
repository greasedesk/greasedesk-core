-- Double-post backstop for imported invoices, as designed.
-- commit.ts already checks at runtime, but two concurrent commits could both pass that check and
-- both write; only a constraint makes it impossible.
-- SAFE: verified 0 duplicate (group_id, external_ref) pairs before applying. NULL external_ref is
-- exempt from a UNIQUE index in Postgres, so the 70 ordinary invoices are unaffected.
CREATE UNIQUE INDEX "Invoice_group_id_external_ref_key" ON "Invoice"("group_id", "external_ref");
