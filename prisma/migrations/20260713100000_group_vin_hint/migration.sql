-- Tenant-set "Where to find the VIN" hint for the phone card (free text; empty = no hint shown).
-- Multi-tenant copy discipline: the shipped default is EMPTY — no marque, no brand.
ALTER TABLE "Group" ADD COLUMN "vin_hint_text" TEXT;
