/**
 * File: lib/tyres.ts
 * TYRE CONDITION — the thresholds, the two advisories one measurement raises, and the wear rate.
 *
 * ── THE ADVISORIES ARE DERIVED, THE FINDINGS ARE RECORDS ────────────────────────────────────────
 * A TyreReading is a measurement. What it MEANS becomes a VehicleDueItem, so tyres reach the
 * customer report, the invoice advisory block and the marketing list with nobody typing a
 * description. Two different meanings, and the second is the point of the whole design:
 *
 *   DEPTH      the tyre is wearing out.
 *   ALIGNMENT  the tread is worn unevenly ACROSS its width — a tracking job, invisible to any
 *              model that stores one depth, and a second thing to sell that would otherwise be
 *              missed entirely.
 */
export type TyreCorner = 'front_left' | 'front_right' | 'rear_left' | 'rear_right';
export type TyreType = 'summer_standard' | 'summer_runflat' | 'winter_standard' | 'winter_runflat';

/** UK legal minimum: 1.6mm across the central three-quarters. In tenths, like the columns. */
export const LEGAL_MIN_TENTHS = 16;
/** Below this, a garage advises. Owner's rule. */
export const ADVISE_BELOW_TENTHS = 30;
/**
 * Asymmetry across one tread that means alignment rather than age. 2.0mm between the shoulders is
 * well beyond normal camber wear and is not a number a mechanic has to remember — it is applied
 * here, once, and the reading that triggers it carries its own evidence.
 */
export const ALIGNMENT_SPREAD_TENTHS = 20;

export type TyreDepths = { outer: number; centre: number; inner: number };

/**
 * THE PHOTO SLOT for one corner. `JobCardPhoto.slot` is already a free-text key, so a corner photo
 * needs no schema change and inherits the whole existing pipeline — presign, R2, the phone's
 * replay-safe outbox, the customer report's presigned reads.
 *
 * A worn inside edge photographed NEXT TO the number that proves it is the single most persuasive
 * thing on the customer report, which is why the photo belongs to the CORNER and not to a general
 * pile of intake stills.
 */
export const tyreSlot = (corner: TyreCorner): string => `tyre_${corner}`;
export const cornerFromSlot = (slot: string | null | undefined): TyreCorner | null => {
  const m = /^tyre_(front_left|front_right|rear_left|rear_right)$/.exec(String(slot ?? ''));
  return m ? (m[1] as TyreCorner) : null;
};

export const minDepth = (d: TyreDepths): number => Math.min(d.outer, d.centre, d.inner);
/** The shoulder-to-shoulder difference. Centre is excluded: it is low on an over-inflated tyre,
 *  which is a pressure fault, not an alignment one. */
export const shoulderSpread = (d: TyreDepths): number => Math.abs(d.outer - d.inner);

export const CORNER_LABEL: Record<TyreCorner, string> = {
  front_left: 'Front left', front_right: 'Front right',
  rear_left: 'Rear left', rear_right: 'Rear right',
};
export const TYRE_TYPE_LABEL: Record<TyreType, string> = {
  summer_standard: 'Summer', summer_runflat: 'Summer run-flat',
  winter_standard: 'Winter', winter_runflat: 'Winter run-flat',
};

const mm = (tenths: number) => (tenths / 10).toFixed(1);

export type TyreAdvisory = {
  kind: 'depth' | 'alignment';
  corner: TyreCorner;
  description: string;
  /** Illegal now — said plainly, because it is a different conversation from "wearing out". */
  illegal: boolean;
};

/**
 * What ONE reading advises. Returns 0, 1 or 2 advisories.
 *
 * PURE, so every threshold is provable without writing a row — and so the rule can be read in one
 * place rather than inferred from what happened to get created.
 */
export function tyreAdvisories(corner: TyreCorner, d: TyreDepths): TyreAdvisory[] {
  const out: TyreAdvisory[] = [];
  const low = minDepth(d);
  if (low < ADVISE_BELOW_TENTHS) {
    const illegal = low < LEGAL_MIN_TENTHS;
    out.push({
      kind: 'depth', corner, illegal,
      description: illegal
        ? `${CORNER_LABEL[corner]} tyre — ${mm(low)}mm, below the legal limit`
        : `${CORNER_LABEL[corner]} tyre — ${mm(low)}mm`,
    });
  }
  // SEPARATE, and raised even on a tyre with plenty of tread left: catching it EARLY is the point.
  // A tyre worn 6/4/2 has years of centre tread and is being destroyed by the geometry.
  if (shoulderSpread(d) >= ALIGNMENT_SPREAD_TENTHS) {
    const inner = d.inner < d.outer;
    out.push({
      kind: 'alignment', corner, illegal: false,
      description: `Check alignment — ${CORNER_LABEL[corner].toLowerCase()} tyre worn on the ${inner ? 'inside' : 'outside'} edge (${mm(d.outer)}/${mm(d.centre)}/${mm(d.inner)}mm)`,
    });
  }
  return out;
}

/**
 * THE PRINTED TYRE LINES for the invoice's frozen advisory block — plain text, one per corner.
 *
 *   Front left — 6.0 / 4.0 / 2.0mm (inside edge worn)
 *
 * Text and not a table for the same reason the rest of the block is text: it has to survive
 * freeze-at-issue byte-for-byte, and a structured child table freezes worse than a string.
 */
export function printedTyreLines(
  readings: Array<{ corner: TyreCorner; depths: TyreDepths }>,
): string[] {
  const ORDER: TyreCorner[] = ['front_left', 'front_right', 'rear_left', 'rear_right'];
  return [...readings]
    .sort((a, b) => ORDER.indexOf(a.corner) - ORDER.indexOf(b.corner))
    .map(({ corner, depths: d }) => {
      const uneven = shoulderSpread(d) >= ALIGNMENT_SPREAD_TENTHS
        ? ` (${d.inner < d.outer ? 'inside' : 'outside'} edge worn)` : '';
      const illegal = minDepth(d) < LEGAL_MIN_TENTHS ? ' — BELOW LEGAL LIMIT' : '';
      return `${CORNER_LABEL[corner]} — ${mm(d.outer)} / ${mm(d.centre)} / ${mm(d.inner)}mm${uneven}${illegal}`;
    });
}

export type WearRate =
  | { ok: true; tenthsPerThousandMiles: number; from: string; to: string; milesCovered: number }
  | { ok: false; reason: 'too_few' | 'no_mileage' | 'gained_tread' };

/**
 * HOW FAST THIS TYRE IS WEARING — measured for THIS car and THIS corner, never assumed.
 *
 * ── WHY THERE IS NO DEFAULT ─────────────────────────────────────────────────────────────────────
 * A first reading cannot say when a tyre will reach the limit. The obvious shortcut is a textbook
 * "1mm per 10,000 miles", and that is a fabricated constant of exactly the kind refused for the
 * video deflation factor: it would produce a confident date nobody measured. Two readings give a
 * real rate; one gives an honest refusal, and the due item sits on `next_service` until then.
 *
 * Same discipline as lib/odometer's span rule, for the same reason.
 */
export function tyreWearRate(
  readings: Array<{ measuredAt: Date; minTenths: number; odometer: number | null }>,
): WearRate {
  const withMiles = readings.filter((r) => r.odometer != null).sort((a, b) => a.measuredAt.getTime() - b.measuredAt.getTime());
  if (withMiles.length < 2) return { ok: false, reason: readings.length < 2 ? 'too_few' : 'no_mileage' };
  const first = withMiles[0], last = withMiles[withMiles.length - 1];
  const miles = (last.odometer as number) - (first.odometer as number);
  if (miles <= 0) return { ok: false, reason: 'no_mileage' };
  const worn = first.minTenths - last.minTenths;
  // A tyre that gained tread was replaced between visits — a new tyre, not a slower one. No rate.
  if (worn <= 0) return { ok: false, reason: 'gained_tread' };
  return {
    ok: true,
    tenthsPerThousandMiles: Math.round((worn / miles) * 1000 * 10) / 10,
    from: first.measuredAt.toISOString().slice(0, 10),
    to: last.measuredAt.toISOString().slice(0, 10),
    milesCovered: miles,
  };
}

/** Miles until this tyre reaches the legal limit, or null when we cannot say. */
export function milesToLegal(currentTenths: number, rate: WearRate): number | null {
  if (!rate.ok || rate.tenthsPerThousandMiles <= 0) return null;
  const remaining = currentTenths - LEGAL_MIN_TENTHS;
  if (remaining <= 0) return 0;
  return Math.round((remaining / rate.tenthsPerThousandMiles) * 1000);
}

// ── THE WRITER ───────────────────────────────────────────────────────────────────────────────────
import type { Prisma } from '@prisma/client';
import { tyreDepthKey, TYRE_ALIGNMENT_KEY } from '@/lib/observation-keys';

/**
 * Record four corners and raise what they advise. ONE writer, so a reading can never exist without
 * its advisories having been considered.
 *
 * ── THE BASIS IS next_service UNTIL THERE IS EVIDENCE ───────────────────────────────────────────
 * A depth advisory becomes a `mileage` due item only once this car's own wear rate exists (two
 * readings with odometers). Before that it is `next_service` — honest, and it upgrades itself on
 * the next visit without anyone revisiting it.
 *
 * An ALIGNMENT advisory is always `next_service`: geometry does not wear out at a mileage, it is
 * wrong now and wants correcting before it destroys the tyre.
 *
 * ── AND IT DOES NOT DUPLICATE ───────────────────────────────────────────────────────────────────
 * Re-measuring the same corner on the same visit replaces the reading (unique on card+corner) and
 * must not stack a second identical advisory. An OPEN advisory of the same kind for the same corner
 * is updated in place rather than added.
 */
export async function recordTyreReadings(
  tx: Prisma.TransactionClient,
  args: {
    groupId: string; vehicleId: string; jobCardId: string; measuredBy: string | null;
    odometer: number | null;
    corners: Array<{ corner: TyreCorner; type: TyreType; depths: TyreDepths }>;
  },
): Promise<{ readings: number; advisories: number }> {
  let advisories = 0;
  for (const c of args.corners) {
    await (tx as Prisma.TransactionClient).tyreReading.upsert({
      where: { job_card_id_corner: { job_card_id: args.jobCardId, corner: c.corner } },
      create: {
        group_id: args.groupId, vehicle_id: args.vehicleId, job_card_id: args.jobCardId,
        corner: c.corner, type: c.type,
        depth_outer_tenths: c.depths.outer, depth_centre_tenths: c.depths.centre, depth_inner_tenths: c.depths.inner,
        measured_by: args.measuredBy,
      },
      update: {
        type: c.type,
        depth_outer_tenths: c.depths.outer, depth_centre_tenths: c.depths.centre, depth_inner_tenths: c.depths.inner,
        measured_at: new Date(), measured_by: args.measuredBy,
      },
    });

    // ── measured_at IS NOT RELIABLE BEFORE 20 AUGUST 2026, ON A SMALL KNOWN SET ────────────────
    // The upsert below sets measured_at on every write. Until 20 Aug the phone's capture form
    // failed to seed from this visit's readings when the card was painted from the IndexedDB
    // cache, so it opened blank and one save re-wrote all four corners — re-dating corners nobody
    // had re-measured. Fixed in 526411c; the swept damage, measured 20 August 2026:
    //
    //   DE59SXW  CONFIRMED — invoice 100003222 froze four readings at 14:36 and all four now
    //            carry 14:40. Two corners were genuinely re-measured; front-left and front-right
    //            kept their VALUES and lost their dates.
    //   LL67ZZK  INDETERMINATE — one whole-set write at 13:08, no invoice and no earlier snapshot,
    //            so a first capture and a re-date are indistinguishable here. Up to 4 corners.
    //   Nothing else: only four cards in the database carry tyre readings at all.
    //
    // NOT REPAIRED, and not repairable: the values are right and no original timestamp survives.
    // Recorded here because this is the function that would turn those dates into a wear rate.
    //
    // THE WEAR RATE, for THIS corner on THIS car — from history, never a textbook figure.
    const history = (await (tx as Prisma.TransactionClient).tyreReading.findMany({
      where: { group_id: args.groupId, vehicle_id: args.vehicleId, corner: c.corner },
      orderBy: { measured_at: 'asc' },
      select: { measured_at: true, depth_outer_tenths: true, depth_centre_tenths: true, depth_inner_tenths: true, job_card: { select: { odometer_in: true } } },
    })) as Array<{ measured_at: Date; depth_outer_tenths: number; depth_centre_tenths: number; depth_inner_tenths: number; job_card: { odometer_in: number | null } | null }>;
    const rate = tyreWearRate(history.map((h) => ({
      measuredAt: h.measured_at,
      minTenths: Math.min(h.depth_outer_tenths, h.depth_centre_tenths, h.depth_inner_tenths),
      odometer: h.job_card?.odometer_in ?? null,
    })));

    for (const a of tyreAdvisories(c.corner, c.depths)) {
      const toLegal = a.kind === 'depth' ? milesToLegal(minDepth(c.depths), rate) : null;
      const useMileage = a.kind === 'depth' && toLegal != null && args.odometer != null;
      // Same corner, same kind, still open → correct it rather than stacking a near-duplicate.
      //
      // BY KEY, not by description prefix. The prefix version matched prose: a hand-typed "Rear
      // left brake pad low" starts with "Rear left", so the next depth advisory for that corner
      // silently rewrote the mechanic's own finding into a tyre one.
      const key = a.kind === 'depth' ? tyreDepthKey(a.corner) : TYRE_ALIGNMENT_KEY;
      const existing = await (tx as Prisma.TransactionClient).vehicleDueItem.findFirst({
        where: { group_id: args.groupId, vehicle_id: args.vehicleId, closed_at: null, observation_key: key },
        select: { id: true },
      });
      const data = {
        observation_key: key,
        description: a.description,
        due_basis: (useMileage ? 'mileage' : 'next_service') as 'mileage' | 'next_service',
        due_mileage: useMileage ? (args.odometer as number) + (toLegal as number) : null,
      };
      if (existing) {
        await (tx as Prisma.TransactionClient).vehicleDueItem.update({ where: { id: existing.id }, data });
      } else {
        await (tx as Prisma.TransactionClient).vehicleDueItem.create({
          data: {
            group_id: args.groupId, vehicle_id: args.vehicleId, found_on_job_card_id: args.jobCardId,
            ...data,
            // Nobody has spoken to the customer yet — the report will ask them.
            customer_response: 'not_raised',
            created_by: args.measuredBy,
          },
        });
        advisories += 1;
      }
    }
  }
  return { readings: args.corners.length, advisories };
}
