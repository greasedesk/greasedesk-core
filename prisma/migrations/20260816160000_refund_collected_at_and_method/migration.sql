-- Refund gets WHEN THE MONEY MOVED, and HOW.
--
-- collected_at / created_at are the same pair Payment already uses, with the same names for the
-- same idea. On the card path they looked redundant for months because the webhook writes the row
-- seconds after Stripe moves the money. They are not the same fact: a garage handing cash back on
-- Friday and recording it on Tuesday moved the money on FRIDAY, and that is the VAT-relevant date.
--
-- NO DEFAULT IS LEFT BEHIND. Adding a NOT NULL column to a populated table needs a value for the
-- existing rows, and the tempting shape is `NOT NULL DEFAULT now()` — which is exactly the
-- scaffolding that sat on Overhead.ex_vat_amount_pennies for six weeks and had to be dropped in its
-- own migration this morning. So: add nullable, backfill, then constrain. The column ends with no
-- default, so a future insert that forgets the date FAILS instead of silently recording today.
ALTER TABLE "Refund" ADD COLUMN "collected_at" TIMESTAMP(3);

-- One row exists (the £50 card refund on 16 Aug). Its created_at is when the webhook wrote it,
-- which is the same day as the movement — right period, ~90 minutes late. Backfilled honestly
-- rather than left null; card refunds written from now on take the Stripe refund's own `created`.
UPDATE "Refund" SET "collected_at" = "created_at" WHERE "collected_at" IS NULL;

ALTER TABLE "Refund" ALTER COLUMN "collected_at" SET NOT NULL;

-- HOW it went back. Mirrors Payment, snapshot included: a renamed method must not rewrite history.
-- NULL on a card refund — the method there is not the garage's to choose.
ALTER TABLE "Refund" ADD COLUMN "payment_method_id" TEXT;
ALTER TABLE "Refund" ADD COLUMN "payment_method_snapshot" TEXT;

-- Period questions ask when the money MOVED, so they index on that — same as Payment.
CREATE INDEX "Refund_group_id_collected_at_idx" ON "Refund"("group_id", "collected_at");

ALTER TABLE "Refund" ADD CONSTRAINT "Refund_payment_method_id_fkey"
  FOREIGN KEY ("payment_method_id") REFERENCES "PaymentMethod"("id") ON DELETE SET NULL ON UPDATE CASCADE;
