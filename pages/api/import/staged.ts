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
import { requireImportApi, importableSiteIds } from '@/lib/admin-guard';
import { resolveLine } from '@/lib/import-memory';
import { suggestForLine } from '@/lib/import-suggest';
import { blockingReasons } from '@/lib/import-blockers';
import { numOrNull } from '@/lib/import-split';
import { lineLabourCentihours } from '@/lib/charged-labour';
import { writeImportAudit } from '@/lib/audit';
import { durationOptions, seedDurationFromMinutes, durationToWorkingMinutes } from '@/lib/booking-slots';
import { computeFootprint, footprintsClash, parseBreaks } from '@/lib/occupancy';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const vis = await requireImportApi(req, res);
  if (!vis) return;
  if (!vis.groupId) return res.status(403).json({ message: 'You do not have permission to import invoices.' });

  const id = String(req.query.id || req.body?.id || '');
  if (!id) return res.status(400).json({ message: 'id is required.' });

  const staged = await prisma.stagedInvoice.findFirst({
    where: { id, group_id: vis.groupId },
    include: { lines: { orderBy: { position: 'asc' } }, batch: { select: { id: true, site_id: true, label: true } } },
  });
  if (!staged) return res.status(404).json({ message: 'Staged invoice not found.' });
  // SITE SCOPE: this batch's location must be one the caller may work in. Group scope alone is not
  // enough on a multi-site tenant — a manager of Site A has no business importing into Site B.
  if (!importableSiteIds(vis).includes(staged.batch.site_id)) {
    return res.status(403).json({ message: 'That batch belongs to a location you do not work in.' });
  }

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
    // ONE resolution of "how many hours is this line", shared with the ledger (lib/charged-labour).
    // This used to compute labour_hours × qty locally while chargedLabourCentihours ignored
    // labour_hours entirely — so a "Labour" row at qty 2 with 2 hours entered suggested a 4-hour
    // booking and was counted as 2 charged hours. Two readers, two answers, from the same row.
    const labourMinutes = Math.round(
      staged.lines
        .filter((l: any) => !splitParentIds.has(l.id))
        .reduce((a: number, l: any) => a + lineLabourCentihours({
          item_type: l.kind, qty: l.qty, labour_hours: l.labour_hours,
        }).centihours, 0) / 100 * 60,
    );
    const suggestedDuration = labourMinutes > 0
      ? seedDurationFromMinutes(labourMinutes, workingDayMinutes, slotMin)
      : null;

    // PRESELECTION. Marking taken lifts but choosing none left the commonest case — one free lift —
    // as an extra decision the operator had to make 42 times. Suggest the first free lift in display
    // order; it is a SUGGESTION the wizard applies, not a silent server-side booking.
    const suggestedLiftId = lifts.find((l) => l.free)?.id ?? null;

    return res.status(200).json({
      staged, memory, match, lifts, suggestedLiftId, footprintEmpty, catalogue, splitTemplates,
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

    try {
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
        // A skip is a RECORDED decision, so the record has to say something. Defaulting the reason
        // to "skipped by operator" would have made the audit row worthless — the one question it
        // exists to answer is WHY this invoice is not in the ledger.
        if (b.status === 'skipped') {
          const reason = (b.skipReason ?? '').trim();
          if (reason.length < 3) throw new Error('SKIP_REASON_REQUIRED');
          data.skip_reason = reason;
        }
        // Reopening clears the reason: it is no longer true, and a stale one would read as current.
        if (b.status === 'pending' || b.status === 'in_progress') data.skip_reason = null;
      }
      if (Object.keys(data).length) await tx.stagedInvoice.update({ where: { id: staged.id }, data });

      if (b.status === 'skipped') {
        await writeImportAudit(tx, {
          groupId: vis.groupId as string, actorUserId: vis.userId, batchId: staged.batch.id,
          action: 'import.skipped',
          diff: { external_ref: staged.external_number, reason: data.skip_reason },
        });
        // A skip can be the LAST outstanding item, so the batch can close here too.
        const outstanding = await tx.stagedInvoice.count({
          where: { batch_id: staged.batch.id, status: { in: ['pending', 'in_progress'] } },
        });
        if (outstanding === 0) {
          const [c, sk, tot] = await Promise.all([
            tx.stagedInvoice.count({ where: { batch_id: staged.batch.id, status: 'committed' } }),
            tx.stagedInvoice.count({ where: { batch_id: staged.batch.id, status: 'skipped' } }),
            tx.stagedInvoice.count({ where: { batch_id: staged.batch.id } }),
          ]);
          await tx.importBatch.update({ where: { id: staged.batch.id }, data: { status: 'committed' } });
          await writeImportAudit(tx, {
            groupId: vis.groupId as string, actorUserId: vis.userId, batchId: staged.batch.id,
            action: 'import.batch_closed', diff: { committed: c, skipped: sk, total: tot },
          });
        }
      }

      // REOPENING. A batch closed because nothing was outstanding; reopening an invoice makes
      // something outstanding again, so the batch must follow or its status would lie.
      if (b.status === 'pending' || b.status === 'in_progress') {
        const batch = await tx.importBatch.findUnique({ where: { id: staged.batch.id }, select: { status: true } });
        if (batch?.status === 'committed') {
          await tx.importBatch.update({ where: { id: staged.batch.id }, data: { status: 'open' } });
        }
      }

      for (const l of b.lines ?? []) {
        const row = staged.lines.find((x: any) => x.id === l.id);
        if (!row) continue;
        // PARTS AND LABOUR NEVER SHARE A LINE. Declaring the kind clears the figure that belongs to
        // the other kind, so switching a line from parts to labour cannot leave a stale parts cost
        // behind it — invisible in the UI (which shows one field) but still counted in the P&L.
        // ENTERING A COST IS A DECLARATION. On the quote form a line's section is what it is; here
        // the equivalent act is filling the section's field, so typing a parts cost on an
        // undeclared line places it in Parts rather than leaving it in limbo with a figure.
        const impliedByCost = l.kind === undefined && row.kind == null && numOrNull(l.partsCost) != null ? 'part' : null;
        const declared = (l.kind as any) ?? impliedByCost ?? row.kind;
        const wipeParts = declared === 'labour';
        const wipeHours = declared === 'part' || declared === 'misc' || declared === 'fixed';
        // RETROACTIVE, like aliasing and splitting: declaring what "Supply Thermostat @ £108.3333"
        // IS settles every pending occurrence of it across the batch, not just this invoice's copy.
        // Without it the operator answers the same question 88 times instead of 54.
        if (declared && declared !== row.kind && !row.parent_line_id && !row.is_adjustment) {
          const reach = await tx.stagedLine.updateMany({
            where: {
              description: row.description, unit_price: row.unit_price,
              parent_line_id: null, is_adjustment: false, id: { not: row.id },
              staged_invoice: { group_id: vis.groupId as string, status: { in: ['pending', 'in_progress'] } },
            },
            data: {
              kind: declared,
              ...(wipeParts ? { parts_cost: null } : {}),
              ...(wipeHours ? { labour_hours: null } : {}),
            },
          });
          // A DECLARATION IS BATCH-WIDE AND ONE CLICK AWAY. It decides which figure the operator is
          // asked for, and it reaches every pending copy of the line — yet it left no trace, so
          // "why is this in Labour?" needed forensics three times on one invoice. Now it is audited
          // with what it was, what it became, and how far it reached.
          await writeImportAudit(tx, {
            groupId: vis.groupId as string, actorUserId: vis.userId, batchId: staged.batch.id,
            action: 'import.line_declared',
            diff: {
              external_ref: staged.external_number,
              line: row.description,
              unit_price: Number(row.unit_price),
              from: row.kind ?? null,
              to: declared,
              via: l.kind !== undefined ? 'moved between sections' : 'cost entered',
              alsoAppliedTo: reach.count, // other pending copies across the batch
            },
          });
        }
        await tx.stagedLine.update({
          where: { id: row.id },
          data: {
            // Adjustments are credits: cost pinned to 0.00, never prompted for.
            // numOrNull, not `== null`: the line inputs are TEXT, and a cleared box sends ''. This
            // caller happens to convert '' client-side, but the same omission on the split path
            // reached Prisma as a Decimal and crashed the request — so the boundary normalises here
            // too rather than trusting every caller to remember.
            parts_cost: row.is_adjustment ? (0 as any)
              : wipeParts ? null
              : (l.partsCost !== undefined ? (numOrNull(l.partsCost) as any) : row.parts_cost),
            labour_hours: wipeHours ? null
              : (l.labourHours !== undefined ? (numOrNull(l.labourHours) as any) : row.labour_hours),
            cost_basis: l.costBasis ?? row.cost_basis,
            kind: declared,
            catalogue_item_id: l.catalogueItemId ?? row.catalogue_item_id,
          },
        });
      }
    });

    } catch (e: any) {
      if (e?.message === 'SKIP_REASON_REQUIRED') {
        return res.status(400).json({ message: 'Give a reason for skipping this invoice.' });
      }
      throw e;
    }

    return res.status(200).json({ message: 'Saved.' });
  }

  res.setHeader('Allow', 'GET, PATCH');
  return res.status(405).json({ message: 'Method Not Allowed' });
}
