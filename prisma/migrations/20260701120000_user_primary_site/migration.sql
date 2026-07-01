-- Additive/non-destructive: admin-set landing/default site per user. Nullable; validated in-app to
-- be one of the user's assigned sites. No FK (a deleted site is handled by the graceful fallback).
ALTER TABLE "User" ADD COLUMN "primary_site_id" TEXT;
