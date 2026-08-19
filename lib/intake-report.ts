/**
 * File: lib/intake-report.ts
 * WHAT THE CUSTOMER SEES AFTER INTAKE — the walkaround, the damage, and what the car needs.
 *
 * ── THIS SCREEN IS THE PRODUCT, TO A CUSTOMER ───────────────────────────────────────────────────
 * It is the only GreaseDesk a car owner ever meets, and — during a sale — the screen that makes the
 * whole intake process real to a prospect who has never used the software: their car, their video,
 * their findings, their tap. It gets more care than an internal panel, not less.
 *
 * ── IT CARRIES NO PRICES, AND THAT IS THE DESIGN ────────────────────────────────────────────────
 * A finding has no price when it is recorded, and often cannot have one until the car is apart
 * ("front discs, may need carriers"). Pricing before sending would put the office on the critical
 * path of a bay activity and delay the report past the moment the car is still on the ramp — the
 * exact failure the findings feature exists to fix. So a "yes" here means QUOTE ME FOR THIS. The
 * estimate goes out afterwards and comes back through acceptQuote like any other.
 */
import { prisma } from '@/lib/db';
import { presignGet } from '@/lib/r2';
import { openDueItemsForVehicle, dueLabel, latestCustomerAnswers, type CustomerAnswer, type OpenDueItem } from '@/lib/due-items';
import { slotOwnedBySection } from '@/lib/photo-slots';
import { batteryState, batteryAdvisory, volts, BATTERY_SLOTS, type BatteryState, type CcaStandard } from '@/lib/battery';
import { tyreSlot, minDepth, shoulderSpread, CORNER_LABEL, TYRE_TYPE_LABEL, LEGAL_MIN_TENTHS, ADVISE_BELOW_TENTHS, ALIGNMENT_SPREAD_TENTHS, type TyreCorner, type TyreType } from '@/lib/tyres';

export type ReportMedia = {
  id: string;
  kind: 'photo' | 'video';
  url: string | null;
  posterUrl: string | null;
  label: string | null;
  durationSeconds: number | null;
  rotation: number;
};

export type ReportFinding = {
  id: string;
  description: string;
  /** The timing in the same words every other surface uses. NEVER a price. */
  timing: string;
  /** What this customer has already tapped, if anything — so a revisit shows their own answer. */
  answered: CustomerAnswer | null;
};

export type ReportTyre = {
  corner: TyreCorner;
  label: string;
  type: string;
  /** Millimetres, one decimal — the customer's units, not our storage tenths. */
  outer: string; centre: string; inner: string;
  /** The lowest of the three, which is what the law and the advisory both care about. */
  lowest: string;
  /** 'ok' | 'advise' | 'illegal' — a band, so the page colours without re-deriving thresholds. */
  band: 'ok' | 'advise' | 'illegal';
  /** Worn across its width, and which way. NULL when the tread is even. */
  unevenEdge: 'inside' | 'outside' | null;
  photos: ReportMedia[];
};

export type ReportBattery = {
  /** Volts, two decimals — how the tester displays it, so the customer can match the photo. */
  voltage: string;
  socPct: number;
  sohPct: number;
  /** The denominator the health figure was measured against. NULL when nobody recorded it, and
   *  shown as such rather than omitted: a percentage against an unknown rating is worth less. */
  ratedCca: number | null;
  ccaStandard: string | null;
  /** The state in lib/battery's words, so the page colours without re-deriving any threshold. */
  state: BatteryState;
  /** What we are actually telling them. NULL when the test came back clean. */
  advisory: string | null;
  photos: ReportMedia[];
};

export type IntakeReport = {
  garageName: string;
  garagePhone: string | null;
  registration: string | null;
  vehicleDesc: string | null;
  /** The walkaround. First, and on its own — it is the centrepiece. */
  walkaround: ReportMedia | null;
  /** Damage stills and any other intake photos. */
  photos: ReportMedia[];
  findings: ReportFinding[];
  /** Four corners, in the car's own layout. A MEASUREMENT — never given yes/no buttons. */
  tyres: ReportTyre[];
  /** The battery test, with the photos of the tester screen. NULL when the car was not tested —
   *  and null, not an empty object, because "not tested" is not "tested and fine". */
  battery: ReportBattery | null;
  /** True once every finding has an answer — the page then thanks them rather than nagging. */
  allAnswered: boolean;
};

/**
 * Build the report for one card. Returns null when the card or its vehicle has gone.
 *
 * PRESIGNED URLS ARE SHORT-LIVED (15 minutes, lib/r2). That is deliberate — it bounds a leaked
 * URL — and it is why the page re-presigns rather than holding one for the session: a 20MB
 * walkaround on forecourt signal can outlive the window mid-stream, and a video that stalls with
 * no explanation is worse than one that takes a moment to start.
 */
export async function buildIntakeReport(jobCardId: string, groupId: string): Promise<IntakeReport | null> {
  const card = (await prisma.jobCard.findFirst({
    where: { id: jobCardId, group_id: groupId },
    select: {
      id: true, vehicle_id: true,
      vehicle: { select: { registration: true, make: true, model: true } },
      site: { select: { phone: true } },
      group: { select: { group_name: true, trading_name: true, phone: true } },
    },
  })) as any;
  if (!card) return null;

  const media = (await prisma.jobCardPhoto.findMany({
    where: { job_card_id: jobCardId, stage: 'intake' },
    orderBy: { uploaded_at: 'asc' },
    select: { id: true, media_type: true, slot: true, label: true, duration_seconds: true, r2_key: true, poster_r2_key: true, rotation: true },
  })) as any[];

  const shape = async (r: any): Promise<ReportMedia> => ({
    id: r.id,
    kind: r.media_type === 'video' ? 'video' : 'photo',
    url: r.r2_key ? await presignGet(r.r2_key) : null,
    // A POSTER IS WHY THE VIDEO DOES NOT AUTOPLAY. 20MB downloading itself on cellular is a cost
    // the customer never agreed to; they see a still and press play if they want it.
    posterUrl: r.poster_r2_key ? await presignGet(r.poster_r2_key) : null,
    label: r.label ?? null,
    durationSeconds: r.duration_seconds ?? null,
    rotation: r.rotation ?? 0,
  });

  const videos = media.filter((m) => m.media_type === 'video');
  // Photos that a section renders itself — a tyre corner, a battery tester screen — must not also
  // appear in the general grid. Asked POSITIVELY via lib/photo-slots, because the negative version
  // of this test named one section and would have double-shown the battery photos.
  const stills = media.filter((m) => m.media_type !== 'video' && !slotOwnedBySection(m.slot));

  // ── TYRES: the latest reading per corner, with the photo that proves it ────────────────────
  // Latest per corner across the car's whole history, not just this visit: a customer looking at
  // their check-in wants the current state of the car, and a corner not re-measured today is still
  // the truth about that corner.
  const tyreRows = (await prisma.tyreReading.findMany({
    where: { group_id: groupId, vehicle_id: card.vehicle_id },
    orderBy: { measured_at: 'desc' },
    select: { corner: true, type: true, depth_outer_tenths: true, depth_centre_tenths: true, depth_inner_tenths: true },
  })) as Array<{ corner: TyreCorner; type: TyreType; depth_outer_tenths: number; depth_centre_tenths: number; depth_inner_tenths: number }>;
  const latestByCorner = new Map<TyreCorner, typeof tyreRows[number]>();
  for (const r of tyreRows) if (!latestByCorner.has(r.corner)) latestByCorner.set(r.corner, r);

  const tyres: ReportTyre[] = [];
  for (const [corner, r] of latestByCorner) {
    const d = { outer: r.depth_outer_tenths, centre: r.depth_centre_tenths, inner: r.depth_inner_tenths };
    const low = minDepth(d);
    const spread = shoulderSpread(d);
    tyres.push({
      corner, label: CORNER_LABEL[corner], type: TYRE_TYPE_LABEL[r.type],
      outer: (d.outer / 10).toFixed(1), centre: (d.centre / 10).toFixed(1), inner: (d.inner / 10).toFixed(1),
      lowest: (low / 10).toFixed(1),
      band: low < LEGAL_MIN_TENTHS ? 'illegal' : low < ADVISE_BELOW_TENTHS ? 'advise' : 'ok',
      unevenEdge: spread >= ALIGNMENT_SPREAD_TENTHS ? (d.inner < d.outer ? 'inside' : 'outside') : null,
      photos: await Promise.all(media.filter((m) => m.slot === tyreSlot(corner)).map(shape)),
    });
  }
  // The car's own layout: fronts first, left then right.
  const ORDER: TyreCorner[] = ['front_left', 'front_right', 'rear_left', 'rear_right'];
  tyres.sort((a, b) => ORDER.indexOf(a.corner) - ORDER.indexOf(b.corner));

  // ── BATTERY: the latest test, with the photographs of the tester ───────────────────────────
  // Latest for the CAR, like the tyres, and for the same reason: a customer wants the current
  // state of their car, not only what happened to be measured today.
  const bRow = (await prisma.batteryReading.findFirst({
    where: { group_id: groupId, vehicle_id: card.vehicle_id },
    orderBy: { measured_at: 'desc' },
    select: { voltage_mv: true, soc_pct: true, soh_pct: true, rated_cca: true, cca_standard: true, measured_at: true },
  })) as { voltage_mv: number; soc_pct: number; soh_pct: number; rated_cca: number | null; cca_standard: string | null; measured_at: Date } | null;

  let battery: ReportBattery | null = null;
  if (bRow) {
    const n = {
      voltageMv: bRow.voltage_mv, socPct: bRow.soc_pct, sohPct: bRow.soh_pct,
      ratedCca: bRow.rated_cca, ccaStandard: bRow.cca_standard as CcaStandard | null,
    };
    battery = {
      voltage: volts(bRow.voltage_mv), socPct: bRow.soc_pct, sohPct: bRow.soh_pct,
      ratedCca: bRow.rated_cca, ccaStandard: bRow.cca_standard,
      state: batteryState(n),
      advisory: batteryAdvisory(n, bRow.measured_at)?.description ?? null,
      photos: await Promise.all(media.filter((m) => BATTERY_SLOTS.includes(m.slot)).map(shape)),
    };
  }

  const items = await openDueItemsForVehicle(prisma, groupId, card.vehicle_id);
  const answers = await latestCustomerAnswers(prisma, items.map((i: OpenDueItem) => i.id));

  const findings: ReportFinding[] = items.map((i: OpenDueItem) => ({
    id: i.id,
    description: i.description,
    timing: dueLabel(i),
    answered: answers.get(i.id)?.answer ?? null,
  }));

  return {
    garageName: card.group?.trading_name || card.group?.group_name || 'Your garage',
    // Site number first, group as the fallback — the same precedence every other customer-facing
    // surface uses. A report that says "call us" with no number is a dead end.
    garagePhone: card.site?.phone ?? card.group?.phone ?? null,
    registration: card.vehicle?.registration ?? null,
    vehicleDesc: [card.vehicle?.make, card.vehicle?.model].filter(Boolean).join(' ') || null,
    walkaround: videos.length ? await shape(videos[0]) : null,
    photos: await Promise.all(stills.map(shape)),
    findings,
    tyres,
    battery,
    allAnswered: findings.length > 0 && findings.every((f) => f.answered !== null),
  };
}
