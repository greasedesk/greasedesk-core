-- Car-first re-root, STAGE C: retire the Vehicle.customer_id weld + break the delete-cascade so a
-- person can be severed without nuking the car or its work history.
--
-- NON-ADDITIVE parts (called out): three FK onDelete changes + three NOT NULL relaxations. Nothing
-- is dropped (customer_id columns stay, nullable + vestigial) and NO existing row is mutated — the
-- migration only relaxes constraints; live customer_id values are left exactly as they are. The
-- destructive behaviour (SetNull on person-delete) only fires when a Customer is deleted, which we
-- do ONLY on a throwaway tenant. onUpdate stays CASCADE on all three (unchanged).

-- Vehicle.customer_id: NOT NULL -> nullable; onDelete CASCADE -> SET NULL
ALTER TABLE "Vehicle" ALTER COLUMN "customer_id" DROP NOT NULL;
ALTER TABLE "Vehicle" DROP CONSTRAINT "Vehicle_customer_id_fkey";
ALTER TABLE "Vehicle" ADD CONSTRAINT "Vehicle_customer_id_fkey"
  FOREIGN KEY ("customer_id") REFERENCES "Customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- JobCard.customer_id: NOT NULL -> nullable; onDelete NO ACTION -> SET NULL
ALTER TABLE "JobCard" ALTER COLUMN "customer_id" DROP NOT NULL;
ALTER TABLE "JobCard" DROP CONSTRAINT "JobCard_customer_id_fkey";
ALTER TABLE "JobCard" ADD CONSTRAINT "JobCard_customer_id_fkey"
  FOREIGN KEY ("customer_id") REFERENCES "Customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Booking.customer_id: NOT NULL -> nullable; onDelete NO ACTION -> SET NULL
ALTER TABLE "Booking" ALTER COLUMN "customer_id" DROP NOT NULL;
ALTER TABLE "Booking" DROP CONSTRAINT "Booking_customer_id_fkey";
ALTER TABLE "Booking" ADD CONSTRAINT "Booking_customer_id_fkey"
  FOREIGN KEY ("customer_id") REFERENCES "Customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;
