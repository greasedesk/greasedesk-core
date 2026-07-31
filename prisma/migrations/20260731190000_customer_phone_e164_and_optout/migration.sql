-- Customer contact: machine-dialable phone + per-channel contact preferences.
--
-- phone_e164: derived on write from the RAW `phone` via lib/contact-routes::toE164Digits, using the
-- tenant's country-profile dial code. `phone` is NEVER overwritten — it is the operator's input and
-- what the garage recognises. NULL here = could not be normalised (honest-null), not "no number".
ALTER TABLE "Customer" ADD COLUMN "phone_e164" TEXT;

-- Per-channel opt-out. NULLABLE ON PURPOSE — three states: NULL = no record (unknown), true = opted
-- out, false = explicitly opted in. No DEFAULT: a default false would silently assert consent for
-- 161 existing customers nobody has ever asked. Unknown must never render as "opted in".
ALTER TABLE "Customer" ADD COLUMN "sms_opt_out" BOOLEAN;
ALTER TABLE "Customer" ADD COLUMN "email_opt_out" BOOLEAN;
ALTER TABLE "Customer" ADD COLUMN "opt_out_updated_at" TIMESTAMP(3);

-- Lookup path for the suppression check in sendNotification (recipient string -> customer, in group).
CREATE INDEX "Customer_group_id_phone_e164_idx" ON "Customer"("group_id", "phone_e164");
CREATE INDEX "Customer_group_id_email_idx" ON "Customer"("group_id", "email");
