/**
 * File: lib/diary-booking.ts
 * THE single place a job card is placed on a resource over a time interval, with the double-booking
 * guard. Used by BOTH /api/diary (book an existing card) and /api/jobcard (create + schedule) so
 * there is one guard, never a parallel copy. Runs inside a caller-provided transaction. The caller
 * checks authority (canManageSite) before invoking; this enforces scope + overlap.
 *
 * Throws: CARD_NOT_FOUND | RESOURCE_NOT_FOUND | CROSS_SITE | CLASH:<reg>
 */
import { Prisma } from '@prisma/client';

export type PlaceParams = {
  jobCardId: string;
  resourceId: string;
  start: Date;
  end: Date;
  siteIds: string[];       // caller's visible sites
  heldOnLift?: boolean;
};

export async function placeJobCard(tx: Prisma.TransactionClient, p: PlaceParams): Promise<void> {
  const card = await tx.jobCard.findFirst({ where: { id: p.jobCardId, site_id: { in: p.siteIds } }, select: { id: true, site_id: true } });
  if (!card) throw new Error('CARD_NOT_FOUND');

  const resource = await tx.resource.findFirst({ where: { id: p.resourceId, site_id: { in: p.siteIds } }, select: { id: true, site_id: true } });
  if (!resource) throw new Error('RESOURCE_NOT_FOUND');
  if (resource.site_id !== card.site_id) throw new Error('CROSS_SITE');

  // Interval-overlap guard (half-open): existing.start < new.end AND existing.end > new.start.
  const clash = await tx.jobCard.findFirst({
    where: { id: { not: p.jobCardId }, resource_id: p.resourceId, start_at: { lt: p.end }, end_at: { gt: p.start } },
    select: { vehicle: { select: { registration: true } } },
  });
  if (clash) throw new Error(`CLASH:${clash.vehicle?.registration ?? 'another job'}`);

  await tx.jobCard.update({
    where: { id: p.jobCardId },
    data: { resource_id: p.resourceId, start_at: p.start, end_at: p.end, ...(p.heldOnLift !== undefined ? { held_on_lift: !!p.heldOnLift } : {}) },
  });
}
