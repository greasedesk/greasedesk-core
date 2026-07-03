/**
 * File: lib/diary-booking.ts
 * THE single place a job card is placed on a resource, with the double-booking guard — now
 * OCCUPANCY-FOOTPRINT aware. A booking's WORKING duration (minutes) is the source of truth; the
 * footprint (per-day working-hours segments, wrapping past close onto the next OPEN day) is derived
 * via lib/occupancy. The guard checks the FULL footprint against other bookings' footprints on the
 * same resource, so a job that spills onto a later day can no longer hide a clash there.
 *
 * Used by /api/diary, /api/jobcard-accept and /api/jobcard so there is one guard, never a copy. Runs
 * inside a caller-provided transaction; the caller checks authority (canManageSite) first.
 *
 * Throws: CARD_NOT_FOUND | RESOURCE_NOT_FOUND | CROSS_SITE | EMPTY_FOOTPRINT | CLASH:<reg>
 */
import { Prisma } from '@prisma/client';
import { computeFootprint, footprintsClash, parseBreaks } from '@/lib/occupancy';

export type PlaceParams = {
  jobCardId: string;
  resourceId: string;
  start: Date;
  workingMinutes: number; // WORKING duration; the footprint + end_at are derived from it
  siteIds: string[];      // caller's visible sites
};

// Candidate prefilter lookback: safely larger than the max spill a single booking can produce. The
// booking form caps duration at 5 WORKING days (~1 calendar week even with a couple of closed days),
// so 14 days is conservative. RAISE THIS if the duration cap ever exceeds 5 working days (or if sites
// with very few open-days-per-week are introduced, where 5 working days spans more calendar days).
const PREFILTER_LOOKBACK_MS = 14 * 24 * 3600000;

export async function placeJobCard(tx: Prisma.TransactionClient, p: PlaceParams): Promise<void> {
  const card = await tx.jobCard.findFirst({ where: { id: p.jobCardId, site_id: { in: p.siteIds } }, select: { id: true, site_id: true } });
  if (!card) throw new Error('CARD_NOT_FOUND');

  const resource = await tx.resource.findFirst({ where: { id: p.resourceId, site_id: { in: p.siteIds } }, select: { id: true, site_id: true } });
  if (!resource) throw new Error('RESOURCE_NOT_FOUND');
  if (resource.site_id !== card.site_id) throw new Error('CROSS_SITE');

  // Site hours + open-days drive the footprint (skips whatever is actually closed — never hardcoded).
  const site = await tx.site.findUnique({ where: { id: card.site_id }, select: { open_hour: true, close_hour: true, open_days: true, breaks: true } });
  const openHour = site?.open_hour ?? 8;
  const closeHour = site?.close_hour ?? 18;
  const openDays = site?.open_days && site.open_days.length ? site.open_days : [1, 2, 3, 4, 5, 6];
  const breaks = parseBreaks(site?.breaks);

  const newFp = computeFootprint(p.start.toISOString(), p.workingMinutes, openHour, closeHour, openDays, breaks);
  if (newFp.segments.length === 0) throw new Error('EMPTY_FOOTPRINT');
  const newEnd = new Date(Date.parse(newFp.endISO));

  // Superset prefilter (indexed on resource_id, start_at): any existing booking that could overlap
  // must START within [newStart - LOOKBACK, newFootprintEnd]. end_at is NOT trusted here — the exact
  // test is footprint-vs-footprint below, so a stale end_at can never cause a missed clash.
  const windowStart = new Date(p.start.getTime() - PREFILTER_LOOKBACK_MS);
  const candidates = await tx.jobCard.findMany({
    where: { id: { not: p.jobCardId }, resource_id: p.resourceId, start_at: { gte: windowStart, lte: newEnd } },
    select: { start_at: true, end_at: true, booking_duration_minutes: true, vehicle: { select: { registration: true } } },
  });
  for (const c of candidates) {
    if (!c.start_at) continue;
    // Transitional fallback: a pre-backfill row has NULL duration → recover it from (end_at - start_at),
    // which equals the working-minutes the old naive form implied.
    const mins = c.booking_duration_minutes ?? Math.round(((c.end_at?.getTime() ?? c.start_at.getTime()) - c.start_at.getTime()) / 60000);
    if (!(mins > 0)) continue;
    const fp = computeFootprint(c.start_at.toISOString(), mins, openHour, closeHour, openDays, breaks);
    if (footprintsClash(newFp, fp)) throw new Error(`CLASH:${c.vehicle?.registration ?? 'another job'}`);
  }

  await tx.jobCard.update({
    where: { id: p.jobCardId },
    data: { resource_id: p.resourceId, start_at: p.start, booking_duration_minutes: p.workingMinutes, end_at: newEnd },
  });
}
