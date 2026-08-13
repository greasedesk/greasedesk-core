-- WHAT WAS RECEIVED, AND WHAT WAS CHANGED AFTER THE FACT.
--
-- amount_paid_pennies is NULLABLE and NOT backfilled. Setting it to the invoice total for every
-- historic paid invoice would look tidy and would be a fabrication: nobody recorded an amount at
-- the time, so the honest value is unknown. Readers fall back to the invoice total when it is NULL,
-- which is exactly the behaviour those rows have today.
ALTER TABLE "Invoice" ADD COLUMN "amount_paid_pennies" INTEGER;
ALTER TABLE "Invoice" ADD COLUMN "amendments" JSONB;
