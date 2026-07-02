-- Car-first re-root, STAGE A (additive only). Adds the vehicle-identity anchor + the
-- ownership edge ALONGSIDE the existing Vehicle.customer_id weld. Nothing existing is mutated:
-- the two new nullable Vehicle columns start NULL and are backfilled by a separate capture-first
-- script (see prisma/scripts/backfill_vehicle_identity_ownership.js). The weld stays intact and
-- readable — it is retired in Stage C, never here.

-- CreateTable: VehicleIdentity (VIN-soft-anchored, tenant-scoped now, mergeable cross-tenant later)
CREATE TABLE "VehicleIdentity" (
    "id" TEXT NOT NULL,
    "group_id" TEXT NOT NULL,
    "vin_normalized" TEXT,
    "registration" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "VehicleIdentity_pkey" PRIMARY KEY ("id")
);

-- CreateTable: VehicleOwnership (time-bounded ownership edge; current owner = is_current)
CREATE TABLE "VehicleOwnership" (
    "id" TEXT NOT NULL,
    "vehicle_id" TEXT NOT NULL,
    "customer_id" TEXT NOT NULL,
    "is_current" BOOLEAN NOT NULL DEFAULT true,
    "valid_from" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "valid_to" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "VehicleOwnership_pkey" PRIMARY KEY ("id")
);

-- AlterTable: additive nullable columns on the live Vehicle spine
ALTER TABLE "Vehicle" ADD COLUMN "identity_id" TEXT;
ALTER TABLE "Vehicle" ADD COLUMN "vin_normalized" TEXT;

-- Indexes
CREATE UNIQUE INDEX "VehicleIdentity_group_id_vin_normalized_key" ON "VehicleIdentity"("group_id", "vin_normalized");
CREATE INDEX "VehicleIdentity_group_id_registration_idx" ON "VehicleIdentity"("group_id", "registration");
CREATE INDEX "VehicleOwnership_vehicle_id_idx" ON "VehicleOwnership"("vehicle_id");
CREATE INDEX "VehicleOwnership_customer_id_idx" ON "VehicleOwnership"("customer_id");
CREATE INDEX "VehicleOwnership_vehicle_id_is_current_idx" ON "VehicleOwnership"("vehicle_id", "is_current");
CREATE INDEX "Vehicle_identity_id_idx" ON "Vehicle"("identity_id");
CREATE INDEX "Vehicle_group_id_vin_normalized_idx" ON "Vehicle"("group_id", "vin_normalized");

-- Partial-unique guard (raw SQL — Prisma cannot express WHERE): at most ONE current owner per vehicle.
CREATE UNIQUE INDEX "VehicleOwnership_one_current_per_vehicle" ON "VehicleOwnership"("vehicle_id") WHERE "is_current";

-- Foreign keys
ALTER TABLE "VehicleIdentity" ADD CONSTRAINT "VehicleIdentity_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "Group"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "VehicleOwnership" ADD CONSTRAINT "VehicleOwnership_vehicle_id_fkey" FOREIGN KEY ("vehicle_id") REFERENCES "Vehicle"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "VehicleOwnership" ADD CONSTRAINT "VehicleOwnership_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Vehicle" ADD CONSTRAINT "Vehicle_identity_id_fkey" FOREIGN KEY ("identity_id") REFERENCES "VehicleIdentity"("id") ON DELETE SET NULL ON UPDATE CASCADE;
