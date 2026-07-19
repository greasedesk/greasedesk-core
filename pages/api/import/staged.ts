/**
 * File: pages/api/import/staged.ts
 * ADMIN-only. Read and edit ONE staged invoice — the wizard's working surface.
 *
 *   GET   ?id=…  → staged invoice + lines + line-memory hits + vehicle/customer match + free lifts
 *   PATCH { id, … } → save wizard state (step, planned date/lift, per-line cost/hours/kind, skip)
 *
 * STAGING ONLY. Nothing here touches the ledger.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import { requireAdminApi } from '@/lib/admin-guard';
import { resolveLine } from '@/lib/import-memory';
import { suggestForLine } from '@/lib/import-suggest';
import { blockingReasons } from '@/lib/import-blockers';
import { durationOptions, seedDurationFromMinutes, durationToWorkingMinutes } from '@/lib/booking-slots';
import { computeFootprint, footprintsClash, parseBreaks } from '@/lib/occupancy';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const vis = await requireAdminApi(req, res);
  if (!vis) return;
  if (!vis.groupId) return res.status(403).json({ message: 'Admin access required.' });

  const id = String(req.query.id || req.body?.id || '');
  if (!id) return res.status(400).json({ message: 'id is required.' });

  const staged = await prisma.stagedInvoice.findFirst({
    where: { id, group_id: vis.groupId },
    include: { lines: { orderBy: { position: 'asc' } }, batch: { select: { id: true, site_id: true, label: true } } },
  });
  if (!staged) return res.status(404).json({ message: 'Staged invoice not found.' });

  if (req.method === 'GET') {
    // ── line memory: what do we already know about each description+price? ─────────────────────
    const catalogue = (await prisma.catalogueItem.findMany({
      where: { group_id: vis.groupId },
      select: { id: true, code: true, title: true, name: true, item_type: true, unit_price: true, unit_cost: true, labour_hours: true, active: true },
    })) as any[];

    const memory = await Promise.all(
      staged.lines.map(async (l: any) => ({
        lineId: l.id,
        hit: l.is_adjustment ? null : await resolveLine(vis.groupId as string, l.description, Number(l.unit_price)),
        // Suggestions are RANKED, never applied. A price match with no shared words is marked weak
        // because on the May set every such pair was a coincidence, not a match.
        suggestions: l.is_adjustment ? [] : suggestForLine(l.description, Number(l.unit_price), catalogue),
      })),
    );

    // ── customer/vehicle match by registration — REPORTED EXPLICITLY, never silently applied ───
    let match: any = { vehicle: null, customer: null, willCreate: true };
    if (staged.registration) {
      const norm = staged.registration.toUpperCase().replace(/\s+/g, '');
      const vehicle = await prisma.vehicle.findFirst({
        where: { group_id: vis.groupId, registration_normalized: norm },
        select: { id: true, registration: true, make: true, model: true },
      });
      if (vehicle) {
        // The CURRENT owner via the ownership edge (car-first model), not merely the newest row:
        // a transferred vehicle has historic edges that must not be presented as the owner.
        const edge = await prisma.vehicleOwnership.findFirst({
          where: { vehicle_id: vehicle.id, is_current: true, valid_to: null },
          orderBy: { valid_from: 'desc' },
          select: { customer: { select: { id: true, name: true } } },
        });
        match = { vehicle, customer: edge?.customer ?? null, willCreate: false };
      }
    }

    // ── free lifts on the planned day, INCLUDING cards placed earlier in this same import run ──
    const site = await prisma.site.findUnique({
      where: { id: staged.batch.site_id },
      select: { open_hour: true, close_hour: true, open_days: true, breaks: true, booking_slot_minutes: true },
    });
    const resources = await prisma.resource.findMany({
      where: { site_id: staged.batch.site_id, is_active: true },
      orderBy: { display_order: 'asc' },
      select: { id: true, name: true },
    });
    let lifts: Array<{ id: string; name: string; free: boolean }> = resources.map((r: any) => ({ ...r, free: true }));
    if (staged.planned_start_at && site) {
      const openHour = site.open_hour ?? 8, closeHour = site.close_hour ?? 18;
      const openDays = site.open_days?.length ? site.open_days : [1, 2, 3, 4, 5, 6];
      const breaks = parseBreaks(site.breaks);
      const start = staged.planned_start_at;
      // Footprint from the CHOSEN duration: a 4-hour job and a 30-minute job do not collide with
      // the same bookings, so availability computed on a fixed hour would mislead either way.
      const mins = staged.planned_working_minutes ?? 60;
      const fp = computeFootprint(start.toISOString(), mins, openHour, closeHour, openDays, breaks);
      const dayStart = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate()));
      const dayEnd = new Date(dayStart.getTime() + 86400000);
      const placed = await prisma.jobCard.findMany({
        where: { site_id: staged.batch.site_id, resource_id: { not: null }, start_at: { gte: dayStart, lt: dayEnd } },
        select: { resource_id: true, start_at: true, booking_duration_minutes: true },
      });
      lifts = resources.map((r: any) => {
        const clash = placed.some((c: any) => {
          if (c.resource_id !== r.id || !c.start_at) return false;
          const mins = c.booking_duration_minutes ?? 60;
          return footprintsClash(fp, computeFootprint(c.start_at.toISOString(), mins, openHour, closeHour, openDays, breaks));
        });
        return { id: r.id, name: r.name, free: !clash, ...(fp.segments.length ? {} : {}) };
      });
    }
    const footprintEmpty = !!staged.planned_start_at && !!site &&
      computeFootprint(staged.planned_start_at.toISOString(), staged.planned_working_minutes ?? 60,
        site.open_hour ?? 8, site.close_hour ?? 18,
        site.open_days?.length ? site.open_days : [1, 2, 3, 4, 5, 6], parseBreaks(site.breaks)).segments.length === 0;

    // Remembered splits, keyed description|price so the wizard can pre-fill a later occurrence.
    const tpls = await prisma.lineSplitTemplate.findMany({
      where: { group_id: vis.groupId },
      select: { description: true, unit_price: true, children_json: true },
    });
    const splitTemplates: Record<string, any> = {};
    for (const t of tpls) {
      splitTemplates[`${t.description}|${Number(t.unit_price).toFixed(4)}`] = t.children_json;
    }

    // DURATION. Seeded from the labour hours already entered in step 2 — the split CHILDREN where a
    // line was split, else the line itself, so a split's hours are not double-counted with its
    // parent. Snapped to the site's booking granularity via the same helper the booking form uses.
    const openHour = site?.open_hour ?? 8, closeHour = site?.close_hour ?? 18;
    const slotMin = (site as any)?.booking_slot_minutes ?? 30;
    const workingDayMinutes = Math.max(slotMin, (closeHour - openHour) * 60);
    const splitParentIds = new Set(staged.lines.filter((l: any) => l.parent_line_id).map((l: any) => l.parent_line_id));
    const labourMinutes = Math.round(
      staged.lines
        .filter((l: any) => !splitParentIds.has(l.id) && l.labour_hours != null)
        .reduce((a: number, l: any) => a + Number(l.labour_hours) * Number(l.qty), 0) * 60,
    );
    const suggestedDuration = labourMinutes > 0
      ? seedDurationFromMinutes(labourMinutes, workingDayMinutes, slotMin)
      : null;

    return res.status(200).json({
      staged, memory, match, lifts, footprintEmpty, catalogue, splitTemplates,
      blockers: blockingReasons(staged.lines as any),
      duration: {
        options: durationOptions(openHour, closeHour, slotMin),
        slotMinutes: slotMin,
        workingDayMinutes,
        labourMinutes,                 // 0 when no hours entered yet
        suggested: suggestedDuration,  // null when there is nothing to seed from
        current: staged.planned_working_minutes ?? null,
      },
      siteHours: { openHour: site?.open_hour ?? 8, closeHour: site?.close_hour ?? 18 },
    });
  }

  if (req.method === 'PATCH') {
    const b = (req.body || {}) as {
      wizardStep?: number; plannedStartAt?: string | null; plannedResourceId?: string | null;
      customerName?: string | null; plannedDuration?: string | null;
      status?: 'pending' | 'in_progress' | 'skipped'; skipReason?: string | null;
      lines?: Array<{ id: string; kind?: string | null; partsCost?: number | null; labourHours?: number | null; costBasis?: string | null; catalogueItemId?: string | null }>;
    };

    // A committed invoice is frozen — staging edits stop at the ledger boundary.
    if (staged.status === 'committed') {
      return res.status(409).json({ message: 'This invoice has been committed and can no longer be edited here.' });
    }

    await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      const data: any = {};
      if (b.wizardStep != null) data.wizard_step = b.wizardStep;
      if (b.customerName !== undefined) data.customer_name = (b.customerName ?? '').trim() || null;
      if (b.plannedDuration !== undefined) {
        // "m:90" / "d:2" → WORKING minutes, through the same helper the booking form uses, so a
        // whole-day option means N WORKING days (footprint-aware) rather than 24h of wall clock.
        const site2 = await tx.site.findUnique({ where: { id: staged.batch.site_id }, select: { open_hour: true, close_hour: true, booking_slot_minutes: true } });
        const oh = site2?.open_hour ?? 8, ch = site2?.close_hour ?? 18;
        const wdm = Math.max(site2?.booking_slot_minutes ?? 30, (ch - oh) * 60);
        data.planned_working_minutes = b.plannedDuration ? durationToWorkingMinutes(b.plannedDuration, wdm) : null;
      }
      if (b.plannedStartAt !== undefined) data.planned_start_at = b.plannedStartAt ? new Date(b.plannedStartAt) : null;
      if (b.plannedResourceId !== undefined) data.planned_resource_id = b.plannedResourceId || null;
      if (b.status) {
        data.status = b.status;
        if (b.status === 'skipped') data.skip_reason = b.skipReason || 'skipped by operator';
      }
      if (Object.keys(data).length) await tx.stagedInvoice.update({ where: { id: staged.id }, data });

      for (const l of b.lines ?? []) {
        const row = staged.lines.find((x: any) => x.id === l.id);
        if (!row) continue;
        await tx.stagedLine.update({
          where: { id: row.id },
          data: {
            // Adjustments are credits: cost pinned to 0.00, never prompted for.
            parts_cost: row.is_adjustment ? (0 as any) : (l.partsCost == null ? null : (l.partsCost as any)),
            labour_hours: l.labourHours == null ? null : (l.labourHours as any),
            cost_basis: l.costBasis ?? row.cost_basis,
            kind: (l.kind as any) ?? row.kind,
            catalogue_item_id: l.catalogueItemId ?? row.catalogue_item_id,
          },
        });
      }
    });

    return res.status(200).json({ message: 'Saved.' });
  }

  res.setHeader('Allow', 'GET, PATCH');
  return res.status(405).json({ message: 'Method Not Allowed' });
}
