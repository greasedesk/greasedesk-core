-- Booking UX rework: per-site duration granularity for the Quote-tab slot picker. Additive, nullable-
-- free via a default so existing rows adopt 30 immediately. No data touched; no other change.
ALTER TABLE "Site" ADD COLUMN "booking_slot_minutes" INTEGER NOT NULL DEFAULT 30;
