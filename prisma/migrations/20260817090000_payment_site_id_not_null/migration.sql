-- Payment.site_id becomes NOT NULL, because it was never a fact that could be absent.
--
-- It is a denormalisation of Invoice.site_id. Invoice.site_id is `String`, and Payment.invoice_id
-- is required — so every payment has an invoice, and every invoice has a site. There is no state of
-- the world in which we take money and do not know where. A null here could only ever mean A CALLER
-- FORGOT, and one did: pages/api/jobcard-status selected the invoice WITHOUT site_id, so
-- `siteId: inv.site_id ?? null` read an unselected field as undefined and stored a null. The `?? null`
-- looked like it was handling an absent site; it was hiding a missing line in a select.
--
-- That is not a cosmetic defect. Every counter mark-paid since the backfill produced a null-site row,
-- and the first query ever written against the column scoped on it — dropping £2,485.43, 27% of an
-- August, out of the revenue tile. The reader was fixed to scope through the invoice; this fixes the
-- writer, so the next omission is LOUD instead of plausible.
--
-- Honest-null is for MEANINGFUL absence. This absence was never meaningful.

-- One row (TMBS 100003209). Its own invoice supplies the site, in the same group — no guessing.
UPDATE "Payment" p
   SET "site_id" = i."site_id"
  FROM "Invoice" i
 WHERE p."invoice_id" = i."id"
   AND p."site_id" IS NULL;

-- NO DEFAULT. Same rule as Refund.collected_at: a default would let the next forgotten select write
-- a plausible wrong site instead of failing. The constraint IS the point of the change.
ALTER TABLE "Payment" ALTER COLUMN "site_id" SET NOT NULL;
