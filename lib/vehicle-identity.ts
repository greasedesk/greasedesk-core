/**
 * Car-first re-root — vehicle-identity / ownership chokepoint.
 *
 * ONE place that maintains the Stage-A layer (VehicleIdentity anchor + current VehicleOwnership
 * edge) so callers never hand-roll it and it can't drift. During Stage A this runs ALONGSIDE the
 * existing Vehicle.customer_id weld (dual-write) — callers still write customer_id as today; this
 * only ensures the new layer mirrors it. The weld stays the read source until Stage B.
 *
 * normalizeVin is the single canonical form (upper-case, strip non-alphanumerics) — the same rule
 * the backfill uses, so dedup keys agree everywhere.
 */
import type { Prisma } from '@prisma/client';

export function normalizeVin(vin?: string | null): string | null {
  const n = (vin || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  return n.length ? n : null;
}

/**
 * Canonical registration match key: uppercase, every non-alphanumeric char stripped (spaces, dashes).
 * "BK69 YAV" / "bk69-yav" → "BK69YAV". THE one place reg matching is derived — find-or-create + the reg
 * lookup compare on this so inconsistent spacing can't spawn duplicate vehicles. Returns null if empty.
 */
export function normalizeReg(reg?: string | null): string | null {
  const n = (reg || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  return n.length ? n : null;
}

/**
 * Stage B owner resolution: the CURRENT owner of a vehicle, read from the ownership edge — never
 * from Vehicle.customer_id. Returns the customer_id of the single is_current edge, or null if the
 * vehicle has no current owner (a genuinely new vehicle, or a pre-backfill anomaly the caller heals).
 * This is the read path that replaces the old vehicle.customer_id dereference.
 */
export async function getCurrentOwnerId(
  tx: Prisma.TransactionClient,
  vehicleId: string,
): Promise<string | null> {
  const edge = await tx.vehicleOwnership.findFirst({
    where: { vehicle_id: vehicleId, is_current: true },
    select: { customer_id: true },
  });
  return edge?.customer_id ?? null;
}

/**
 * Ensure a vehicle has a VehicleIdentity (VIN-anchored per tenant when present) and exactly one
 * current ownership edge for the given owner. Idempotent: if the identity/edge already exist they
 * are left as-is. Never writes Vehicle.customer_id. Call inside the same transaction as the vehicle
 * write so the layer can never lag the weld.
 */
export async function ensureIdentityAndCurrentOwner(
  tx: Prisma.TransactionClient,
  args: { vehicleId: string; groupId: string; customerId: string; registration: string; vin?: string | null },
): Promise<void> {
  const vin_normalized = normalizeVin(args.vin);

  const vehicle = await tx.vehicle.findUnique({
    where: { id: args.vehicleId },
    select: { identity_id: true },
  });

  if (!vehicle?.identity_id) {
    // Reuse this tenant's identity for the VIN when present (respects @@unique([group_id,vin_normalized]));
    // otherwise mint a fresh anchor. Blank VIN → always a fresh row (NULLs are distinct).
    const existing = vin_normalized
      ? await tx.vehicleIdentity.findFirst({ where: { group_id: args.groupId, vin_normalized }, select: { id: true } })
      : null;
    const identityId = existing
      ? existing.id
      : (await tx.vehicleIdentity.create({
          data: { group_id: args.groupId, vin_normalized, registration: args.registration },
          select: { id: true },
        })).id;
    await tx.vehicle.update({
      where: { id: args.vehicleId },
      data: { identity_id: identityId, vin_normalized },
    });
  }

  const current = await tx.vehicleOwnership.findFirst({
    where: { vehicle_id: args.vehicleId, is_current: true },
    select: { id: true },
  });
  if (!current) {
    await tx.vehicleOwnership.create({
      data: { vehicle_id: args.vehicleId, customer_id: args.customerId, is_current: true },
    });
  }
}
