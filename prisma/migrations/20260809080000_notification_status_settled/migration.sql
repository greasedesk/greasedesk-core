-- Additive, nullable, no backfill. Every existing row keeps NULL, which is the honest value: none of
-- them was ever confirmed by a provider, because nothing could receive that confirmation.
ALTER TABLE "NotificationLog" ADD COLUMN "status_settled_at" TIMESTAMP(3);
