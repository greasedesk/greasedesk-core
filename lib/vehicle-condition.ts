/**
 * File: lib/vehicle-condition.ts
 * WHAT THE CAR'S TYRES AND BATTERY CURRENTLY SAY — one reader, so the garage and the customer
 * cannot be looking at different answers.
 *
 * ── WHY THIS FILE EXISTS ────────────────────────────────────────────────────────────────────────
 * They were looking at different answers. Tyre and battery readings had exactly three readers —
 * the customer report, the invoice freeze, and the internal wear-rate — and the JOB CARD was not
 * among them. The capture forms were write-only: they initialised blank and were never told what
 * the car already said.
 *
 * On a real MINI on 2026-08-19 that produced the worst possible version of the fault. All four
 * corners saved at 4.0mm and a battery at 76% health; both are healthy, so neither raised a
 * finding; and findings were the only intake data the card could render. The customer's report
 * showed both. The card showed nothing. THE CUSTOMER KNEW MORE ABOUT THE CAR THAN THE GARAGE DID,
 * from the same system — and the mechanic's reasonable conclusion is that the save failed.
 *
 * Note which way it fails: a WORN tyre would at least have appeared as an advisory. It is the
 * reassuring reading that vanishes, which is precisely the one you want to confirm you recorded.
 *
 * ── AGREEMENT IS STRUCTURAL, NOT COINCIDENTAL ───────────────────────────────────────────────────
 * The obvious fix is to give the card its own query shaped like the report's. That produces two
 * derivations of one truth, which agree until somebody edits one of them. So both surfaces call
 * THIS, and each attaches its own media afterwards — the customer report needs presigned URLs, the
 * card does not. The numbers and the bands come from one place.
 *
 * The gate then asserts the two SERVED surfaces agree with each other rather than each agreeing
 * with a fixture, because "they agree" is the actual requirement.
 */
import type { Prisma } from '@prisma/client';
import {
  minDepth, shoulderSpread, CORNER_LABEL, TYRE_TYPE_LABEL,
  LEGAL_MIN_TENTHS, ADVISE_BELOW_TENTHS, ALIGNMENT_SPREAD_TENTHS,
  type TyreCorner, type TyreType,
} from '@/lib/tyres';
import { batteryState, batteryAdvisory, volts, type BatteryState, type CcaStandard } from '@/lib/battery';

/** The car's own layout: fronts first, left then right. */
const CORNER_ORDER: TyreCorner[] = ['front_left', 'front_right', 'rear_left', 'rear_right'];

export type TyreCondition = {
  corner: TyreCorner;
  label: string;
  /** The human name of what is fitted, not the enum. */
  type: string;
  /** Millimetres, one decimal — the units on the gauge, not our storage tenths. */
  outer: string; centre: string; inner: string;
  /** The lowest of the three, which is what the law and the advisory both care about. */
  lowest: string;
  /** A band, so a surface colours without re-deriving a threshold. */
  band: 'ok' | 'advise' | 'illegal';
  /** Worn across its width, and which way. NULL when the tread is even. */
  unevenEdge: 'inside' | 'outside' | null;
  /** ISO date. On the card this matters: a corner not re-measured today is still the truth. */
  measuredOn: string;
};

export type BatteryCondition = {
  voltage: string;
  socPct: number;
  sohPct: number;
  ratedCca: number | null;
  ccaStandard: string | null;
  state: BatteryState;
  /** What it means, in lib/battery's own words. NULL when the test came back clean. */
  advisory: string | null;
  measuredOn: string;
};

/**
 * Just enough of the client to be callable from a page loader OR inside a transaction — the same
 * union openDueItemsForVehicle uses, and for the same reason: the real client and a transaction
 * client differ in ways that do not matter to two reads.
 */
type Db = Prisma.TransactionClient | {
  tyreReading: { findMany: (a: unknown) => Promise<unknown> };
  batteryReading: { findFirst: (a: unknown) => Promise<unknown> };
};
const asDb = (db: Db) => db as {
  tyreReading: { findMany: (a: unknown) => Promise<unknown> };
  batteryReading: { findFirst: (a: unknown) => Promise<unknown> };
};

/**
 * THE LATEST READING PER CORNER, for the CAR rather than for this visit.
 *
 * Deliberately not scoped to the job card: a corner measured last service and not re-measured today
 * is still the truth about that corner, and showing four blanks because only one was re-checked
 * would be the same invisibility in a smaller form.
 */
export async function latestTyres(db: Db, groupId: string, vehicleId: string | null | undefined): Promise<TyreCondition[]> {
  if (!vehicleId) return [];
  const rows = (await asDb(db).tyreReading.findMany({
    where: { group_id: groupId, vehicle_id: vehicleId },
    orderBy: { measured_at: 'desc' },
    select: {
      corner: true, type: true, measured_at: true,
      depth_outer_tenths: true, depth_centre_tenths: true, depth_inner_tenths: true,
    },
  })) as Array<{
    corner: TyreCorner; type: TyreType; measured_at: Date;
    depth_outer_tenths: number; depth_centre_tenths: number; depth_inner_tenths: number;
  }>;

  const latest = new Map<TyreCorner, typeof rows[number]>();
  for (const r of rows) if (!latest.has(r.corner)) latest.set(r.corner, r);

  return [...latest.values()]
    .map((r) => {
      const d = { outer: r.depth_outer_tenths, centre: r.depth_centre_tenths, inner: r.depth_inner_tenths };
      const low = minDepth(d);
      return {
        corner: r.corner,
        label: CORNER_LABEL[r.corner],
        type: TYRE_TYPE_LABEL[r.type],
        outer: (d.outer / 10).toFixed(1),
        centre: (d.centre / 10).toFixed(1),
        inner: (d.inner / 10).toFixed(1),
        lowest: (low / 10).toFixed(1),
        band: (low < LEGAL_MIN_TENTHS ? 'illegal' : low < ADVISE_BELOW_TENTHS ? 'advise' : 'ok') as TyreCondition['band'],
        unevenEdge: shoulderSpread(d) >= ALIGNMENT_SPREAD_TENTHS
          ? ((d.inner < d.outer ? 'inside' : 'outside') as 'inside' | 'outside')
          : null,
        measuredOn: r.measured_at.toISOString().slice(0, 10),
      };
    })
    .sort((a, b) => CORNER_ORDER.indexOf(a.corner) - CORNER_ORDER.indexOf(b.corner));
}

/** The latest battery test for the CAR. NULL means never tested — not "tested and fine". */
export async function latestBattery(db: Db, groupId: string, vehicleId: string | null | undefined): Promise<BatteryCondition | null> {
  if (!vehicleId) return null;
  const row = (await asDb(db).batteryReading.findFirst({
    where: { group_id: groupId, vehicle_id: vehicleId },
    orderBy: { measured_at: 'desc' },
    select: { voltage_mv: true, soc_pct: true, soh_pct: true, rated_cca: true, cca_standard: true, measured_at: true },
  })) as {
    voltage_mv: number; soc_pct: number; soh_pct: number;
    rated_cca: number | null; cca_standard: string | null; measured_at: Date;
  } | null;
  if (!row) return null;

  const n = {
    voltageMv: row.voltage_mv, socPct: row.soc_pct, sohPct: row.soh_pct,
    ratedCca: row.rated_cca, ccaStandard: row.cca_standard as CcaStandard | null,
  };
  return {
    voltage: volts(row.voltage_mv),
    socPct: row.soc_pct,
    sohPct: row.soh_pct,
    ratedCca: row.rated_cca,
    ccaStandard: row.cca_standard,
    state: batteryState(n),
    // The measurement date, not today's: the seasonal wording must not drift as the year turns.
    advisory: batteryAdvisory(n, row.measured_at)?.description ?? null,
    measuredOn: row.measured_at.toISOString().slice(0, 10),
  };
}
