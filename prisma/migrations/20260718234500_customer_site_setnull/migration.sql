-- A customer belongs to the GARAGE, not to a bay.
--
-- Customer.site_id was NOT NULL + ON DELETE CASCADE, so deleting a Location would have deleted its
-- customers, and VehicleOwnership cascades from Customer — taking the car-first ownership edges with
-- it, while Vehicle/JobCard/Booking (SetNull) survived as orphans pointing at nobody. Invoices had
-- DB-level protection (NoAction); customers had only an application-level guard in locations.ts.
-- This gives customer records the same class of protection: the origin site may go, the customer stays.
--
-- Data-safe: widening NOT NULL -> NULL rewrites no rows, and no existing row changes value.
ALTER TABLE "Customer" DROP CONSTRAINT IF EXISTS "Customer_site_id_fkey";
ALTER TABLE "Customer" ALTER COLUMN "site_id" DROP NOT NULL;
ALTER TABLE "Customer" ADD CONSTRAINT "Customer_site_id_fkey"
  FOREIGN KEY ("site_id") REFERENCES "Site"("id") ON DELETE SET NULL ON UPDATE CASCADE;
