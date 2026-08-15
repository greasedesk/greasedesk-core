-- Does this send spend the garage's SMS allowance? Frozen at send time, never re-derived.
--
-- DEFAULT TRUE, and the backfill is deliberately none: every existing row predates the allowance
-- and none of them are queried by lib/sms-allowance (it filters channel='sms' AND
-- provider_message_id IS NOT NULL, and no customer SMS has ever been sent). Setting historic
-- security rows to false would be rewriting a fact about months where the allowance did not exist.
ALTER TABLE "NotificationLog" ADD COLUMN "counts_to_allowance" BOOLEAN NOT NULL DEFAULT true;
