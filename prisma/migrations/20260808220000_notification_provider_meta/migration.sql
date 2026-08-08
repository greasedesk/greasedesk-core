-- Additive, nullable. Existing rows keep a null: we genuinely did not record what the provider said.
ALTER TABLE "NotificationLog" ADD COLUMN "provider_meta" JSONB;
