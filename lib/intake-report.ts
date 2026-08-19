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
  const stills = media.filter((m) => m.media_type !== 'video');

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
    allAnswered: findings.length > 0 && findings.every((f) => f.answered !== null),
  };
}
