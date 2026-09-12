/**
 * File: pages/api/pwa/job/[id].ts
 * GET → the phone's READ-ONLY job card: customer, vehicle (VIN is the anchor grain), the work
 * sold, notes, invoice state. Session-resolved; the client sends no identity. Money is governed
 * by the EXISTING financeVisibility shaping inside buildJobCardPageProps (one truth — not
 * re-implemented here): a price-blind user receives no unit_price because the shaper already
 * stripped it. This endpoint then projects a lean phone shape and NEVER carries unit_cost —
 * for ANY role, ADMIN included (the shared shaper would send it to a cost-visible user; the
 * phone drops the field: a parts factor call needs the VIN, never the trade price).
 * Photos are NOT here — the page lazy-loads them from the existing GET /api/photos (presigned
 * URLs expire; the card TEXT is what must cache offline).
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/pages/api/auth/[...nextauth]';
import { buildJobCardPageProps } from '@/lib/jobcard-page-data';
import { prisma } from '@/lib/db';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  res.setHeader('Cache-Control', 'no-store'); // offline freshness is the client cache's job
  if (req.method !== 'GET') { res.setHeader('Allow', 'GET'); return res.status(405).json({ message: 'Method Not Allowed' }); }
  const session = await getServerSession(req, res, authOptions);
  const user = session?.user as any;
  if (!user?.id || !user?.group_id) return res.status(401).json({ message: 'Not authenticated.' });

  const id = String(req.query.id || '');
  if (!id) return res.status(400).json({ message: 'Missing id.' });

  // THE shared builder = the visibility + finance chokepoint (site scope inside; null = not yours).
  const p = await buildJobCardPageProps(user.id as string, user.group_id as string, id);
  if (!p) return res.status(404).json({ message: 'Job card not found.' });
  const grp = (await prisma.group.findUnique({ where: { id: user.group_id }, select: { vin_hint_text: true } })) as any;

  return res.status(200).json({
    id: p.jobCardId,
    status: p.status,
    isComeback: p.isComeback,
    customer: { name: p.owner.name, phone: p.owner.phone },
    vehicle: {
      registration: p.vehicle.registration,
      make: p.vehicle.make, model: p.vehicle.model, colour: p.vehicle.colour,
      vin: p.vehicle.vin,
      mileageIn: p.vehicle.mileageIn,
    },
    vinHint: grp?.vin_hint_text ?? null, // tenant-worded; null = no hint rendered
    // ── INTAKE CAPTURE, on the surface the mechanic is holding ────────────────────────────────
    // Open findings so the bay does not record a duplicate, the DVSA MOT so nobody retypes it, and
    // the car's last tyre type so the type control is a confirmation rather than an entry. All
    // READ-ONLY context — the writes go through the outbox. Still NO money on this surface.
    dueItems: (p.dueItems ?? []).map((d: { id: string; description: string }) => ({ id: d.id, description: d.description })),
    motExpiry: p.vehicle.motExpiry ?? null,
    lastTyreType: p.lastTyreType ?? null,
    // The battery's rated CCA and standard from this car's last test — so the denominator prefills
    // and a second visit is zero input. STILL no money on this surface.
    lastBattery: p.lastBattery ?? null,
    // This garage's own observation usage, so the tap-list orders itself. Cached with the rest of
    // the payload, so it survives offline — degrading to the cold-start order, never to no list.
    observationCounts: p.observationCounts ?? {},
    // WHAT THE CAR ALREADY SAYS — from lib/vehicle-condition, the same reader the desktop card and
    // the customer report use. The phone's capture forms were write-only too, so a mechanic in the
    // bay could not see the reading they had just taken. Still NO money on this surface.
    tyreCondition: p.tyreCondition ?? [],
    tyresOnThisCard: p.tyresOnThisCard ?? [],
    // THIS VISIT'S ARRIVAL SCHEDULE, so the phone panel opens on what it already recorded rather
    // than blank. The DEPARTURE reading (p.serviceSchedule) is deliberately NOT sent: there is no
    // surface here that could take one safely, so shipping it would be an invitation.
    scheduleOnArrival: p.scheduleOnArrival ?? [],
    batteryCondition: p.batteryCondition ?? null,
    // The four prompts, already resolved server-side. On the phone because an escalation firing
    // for items nobody was ever prompted about is worse than no escalation — the false-positive
    // problem again, one level up.
    intakeItems: p.intakeItems ?? [],
    nothingFoundAt: p.nothingFoundAt ?? null,
    oilLevel: p.oilLevel ?? null,
    // Work sold — NO money fields, for anyone: no unitPrice, no unit_cost. Descriptions and
    // quantities are the job; the sell price has no use in a bay.
    lines: p.lines.map((l) => ({
      type: l.item_type,
      description: l.description,
      qty: l.qty,
      hours: l.labour_hours ?? null,
    })),
    /**
     * CLOCK STATE, on the same round trip as the rest of the card. A second request would be a
     * second chance to fail on a forecourt signal, and this is the one control the tech came for.
     *
     * `open` is THEIR open session anywhere — not just on this card — because the button has to be
     * able to say "you are on VE12 ABC" before it moves them. Both totals travel (labour is the SUM
     * of sessions, elapsed is the span) and the UI shows both: a reader given one assumes the wrong
     * one. Still NO money on this surface.
     */
    clock: await (async () => {
      const { sessionsForCard, openSessionFor } = await import('@/lib/job-clock-store');
      const { jobTotals, sessionState } = await import('@/lib/job-clock');
      const rows = await sessionsForCard(prisma, id);
      const open = await openSessionFor(user.id as string);
      const openReg = open && open.job_card_id !== id
        ? (await prisma.jobCard.findUnique({ where: { id: open.job_card_id }, select: { vehicle: { select: { registration: true } } } }))?.vehicle?.registration ?? null
        : null;
      const totals = jobTotals(rows);
      return {
        openHere: !!open && open.job_card_id === id,
        openElsewhereReg: openReg,
        openSince: open ? open.started_at.toISOString() : null,
        labourMinutes: totals.labourMinutes,
        elapsedMinutes: totals.elapsedMinutes,
        running: totals.running,
        disputed: totals.disputed,
        sessions: rows.map((r) => ({
          id: r.id, state: sessionState(r), startedAt: r.started_at.toISOString(),
          endedAt: r.ended_at ? r.ended_at.toISOString() : null, cause: r.ended_cause,
          isCorrection: !!r.corrects_id,
        })),
      };
    })(),
    notes: p.garageNotes || '',
    invoice: p.invoice ? { number: p.invoice.number, status: p.invoice.status } : null,
    currency: p.currency,
    locale: p.locale,
  });
}
