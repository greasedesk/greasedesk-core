/**
 * File: pages/api/headcount.ts
 * Cost-capture — Headcount (people-as-costs) CRUD. ADMIN/owner ONLY via requireAdminApi:
 * wages are sensitive, so no cost value is ever built into a non-admin payload — a SITE_MANAGER
 * gets 403 here and receives nothing. Allocations validated in lib/cost-allocation.ts (the one
 * place the 100%-sum + tenant-site invariant lives); writes replace allocations atomically.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import { requireAdminApi } from '@/lib/admin-guard';
import { validateAllocations } from '@/lib/cost-allocation';
import { diffEmploymentShape, recordEmploymentEvents, datedConfirmNeeded, EmploymentShape } from '@/lib/employment-events';

const parseDay = (v: unknown): Date | null => {
  const ds = String(v || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(ds)) return null;
  const d = new Date(`${ds}T00:00:00.000Z`);
  return Number.isNaN(d.getTime()) ? null : d;
};
const todayUTC = () => new Date(`${new Date().toISOString().slice(0, 10)}T00:00:00.000Z`);
const day = (d: Date | null | undefined) => (d ? d.toISOString().slice(0, 10) : null);

const COST_TYPES = new Set(['salary', 'hourly']);

const toPennies = (v: unknown): number | null => {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n);
};

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const vis = await requireAdminApi(req, res); // 401/403 handled inside
  if (!vis) return;
  if (!vis.groupId) return res.status(400).json({ message: 'No tenant context.' });
  const groupId = vis.groupId;

  // Tenant site allow-list (definitive, from DB — not the session).
  const sites: Array<{ id: string; site_name: string; is_active: boolean; open_days: number[] }> = await prisma.site.findMany({
    where: { group_id: groupId },
    select: { id: true, site_name: true, is_active: true, open_days: true },
    orderBy: { site_name: 'asc' },
  });
  const tenantSiteIds = sites.map((s) => s.id);

  // ---- GET: list people + their allocations, plus sites for the editor/by-site pivot ----
  if (req.method === 'GET') {
    const people: Array<{
      id: string; name: string; role: string | null; cost_type: 'salary' | 'hourly';
      amount_pennies: number; is_active: boolean; allocations: Array<{ site_id: string; percent: unknown }>;
    }> = await prisma.costPerson.findMany({
      where: { group_id: groupId },
      orderBy: { created_at: 'asc' },
      select: {
        id: true, name: true, role: true, cost_type: true, amount_pennies: true, is_active: true,
        is_chargeable: true, contracted_hours_per_day: true, working_days: true,
        annual_leave_allowance_days: true, start_date: true, pay_start_date: true,
        work_end_date: true, pay_end_date: true, utilisation_factor: true,
        allocations: { select: { site_id: true, percent: true } },
      },
    }) as any;
    return res.status(200).json({
      sites: sites.map((s) => ({ id: s.id, name: s.site_name, isActive: s.is_active, openDays: s.open_days })),
      people: people.map((p: any) => ({
        id: p.id, name: p.name, role: p.role, costType: p.cost_type,
        amountPennies: p.amount_pennies, isActive: p.is_active,
        // Employment shape (utilisation denominator inputs — see lib/capacity).
        isChargeable: p.is_chargeable,
        contractedHoursPerDay: p.contracted_hours_per_day == null ? null : Number(p.contracted_hours_per_day),
        workingDays: p.working_days ?? [],
        startDate: p.start_date ? p.start_date.toISOString().slice(0, 10) : null,
        // NULL pay date = coincides with the work date (a stated default, not unknown). Sent as
        // null so the form can show the disclosure closed until someone genuinely differs.
        payStartDate: p.pay_start_date ? p.pay_start_date.toISOString().slice(0, 10) : null,
        workEndDate: p.work_end_date ? p.work_end_date.toISOString().slice(0, 10) : null,
        payEndDate: p.pay_end_date ? p.pay_end_date.toISOString().slice(0, 10) : null,
        allowanceDays: p.annual_leave_allowance_days == null ? null : Number(p.annual_leave_allowance_days),
        utilisationFactor: p.utilisation_factor,
        allocations: p.allocations.map((a: any) => ({ siteId: a.site_id, percent: Number(a.percent) })),
      })),
    });
  }

  // ---- POST / PATCH: create or update a person + replace its allocations atomically ----
  if (req.method === 'POST' || req.method === 'PATCH') {
    const body = (req.body || {}) as any;
    const isPatch = req.method === 'PATCH';
    const id = typeof body.id === 'string' ? body.id : '';
    if (isPatch && !id) return res.status(400).json({ message: 'Missing id.' });

    // Effective date is the LOAD-BEARING field of the dated model: on PATCH it must be a
    // DELIBERATE pick (required — no silent today-default; the form ships it empty). POST (new
    // hire) anchors on the start date, so today is a fine fallback there. Far-past/future still
    // needs an explicit confirm — never accepted silently.
    // EVERY dated change picks its date, including leaving. markLeft used to be excluded here and
    // then silently defaulted to today — the one dated write in the product that would invent a
    // date rather than refuse. A leaving date is a fact, and today is not a good guess at it.
    if (isPatch && !body.effectiveDate && !(body.action === 'markLeft' && body.workEndDate)) {
      return res.status(400).json({ message: 'Pick the date this change takes effect from.' });
    }
    const effectiveDate = body.effectiveDate ? parseDay(body.effectiveDate) : todayUTC();
    if (!effectiveDate) return res.status(400).json({ message: 'Enter a valid effective date.' });
    if (datedConfirmNeeded(effectiveDate, todayUTC()) && !body.confirmDated) {
      return res.status(409).json({ needsDateConfirm: true, message: 'That effective date is more than a year away — confirm it’s intended.' });
    }

    // ---- Mark as left. History is retained in full — a former employee is never deleted.
    // TWO DATES, because work and pay do not have to stop together: the last
    // WORKING day bounds capacity, the last PAID day bounds cost, and payment in lieu is exactly
    // the case a single date cannot express. They coincide when someone works their notice or
    // walks out, and the form defaults them together — the split costs nothing when unused.
    if (isPatch && body.action === 'markLeft') {
      // NO SILENT DEFAULT. Both the gate above and this refusal are deliberate: the previous
      // `?? todayUTC()` would date a leaving event to whenever the request happened to arrive.
      const workEnd = parseDay(body.workEndDate ?? body.endDate);
      if (!workEnd) return res.status(400).json({ message: 'Enter the last working day.' });
      // Absent = coincides with the last working day. A STATED DEFAULT, not unknown — the fact
      // being recorded is "they left on X", and PILON is the exception that must be entered.
      const payEnd = body.payEndDate ? parseDay(body.payEndDate) : workEnd;
      if (!payEnd) return res.status(400).json({ message: 'Enter a valid last paid day.' });
      if (payEnd.getTime() < workEnd.getTime()) {
        return res.status(400).json({ message: 'The last paid day cannot be before the last working day.' });
      }
      // The far-past/far-future confirm applies to the LEAVING date too — it is dated like any
      // other change, and was previously only reached via the (unused) effectiveDate branch.
      if (datedConfirmNeeded(workEnd, todayUTC()) && !body.confirmDated) {
        return res.status(409).json({ needsDateConfirm: true, message: 'That leaving date is more than a year away — confirm it’s intended.' });
      }
      // OPTIONAL, and never validated into being required: a mandatory reason becomes a field
      // full of "x". Empty stays null so the history says "not recorded", not "".
      const reason = typeof body.reason === 'string' && body.reason.trim() ? body.reason.trim().slice(0, 500) : null;
      const person = (await prisma.costPerson.findFirst({ where: { id, group_id: groupId }, select: { id: true, is_active: true, work_end_date: true, pay_end_date: true } })) as any;
      if (!person) return res.status(404).json({ message: 'Person not found.' });
      if (!person.is_active) return res.status(409).json({ message: 'They’re already marked as left.' });
      await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
        await tx.costPerson.update({ where: { id }, data: { is_active: false, work_end_date: workEnd, pay_end_date: payEnd } });
        await recordEmploymentEvents(tx, {
          groupId, costPersonId: id, changedBy: vis.userId ?? null, effectiveDate: workEnd,
          changes: [{
            kind: 'ended',
            value: { work_end_date: day(workEnd), pay_end_date: day(payEnd), reason },
            previous: { work_end_date: day(person.work_end_date), pay_end_date: day(person.pay_end_date), reason: null },
          }],
        });
      });
      return res.status(200).json({ message: 'Marked as left.' });
    }

    const name = typeof body.name === 'string' ? body.name.trim() : '';
    const role = typeof body.role === 'string' && body.role.trim() ? body.role.trim() : null;
    const costType = String(body.costType || '');
    const amountPennies = toPennies(body.amountPennies);

    if (!name) return res.status(400).json({ message: 'Name is required.' });
    if (!COST_TYPES.has(costType)) return res.status(400).json({ message: 'Cost type must be salary or hourly.' });
    if (amountPennies === null) return res.status(400).json({ message: 'Amount must be a non-negative number of pennies.' });

    const check = validateAllocations(body.allocations, tenantSiteIds);
    if (!check.ok) return res.status(400).json({ message: check.error });

    // Employment shape (capacity inputs). Hours: 0–24 or null; not hard-gated on chargeable —
    // a chargeable person with NULL hours is exactly the utilisation tile's amber condition.
    const isChargeable = !!body.isChargeable;
    let contracted: number | null = null;
    if (body.contractedHoursPerDay != null && body.contractedHoursPerDay !== '') {
      const h = Number(body.contractedHoursPerDay);
      if (!Number.isFinite(h) || h < 0 || h > 24) return res.status(400).json({ message: 'Contracted hours must be between 0 and 24.' });
      contracted = h;
    }
    // Utilisation factor: 0–100 integer, NEVER null (default 70) — the workshop expectation,
    // never an individual score. Only APPLIES to chargeable people (others contribute 0 hours).
    let factor = 70;
    if (body.utilisationFactor != null && body.utilisationFactor !== '') {
      const f = Number(body.utilisationFactor);
      if (!Number.isInteger(f) || f < 0 || f > 100) return res.status(400).json({ message: 'Utilisation factor must be a whole number between 0 and 100.' });
      factor = f;
    } else if (isPatch) {
      factor = -1; // sentinel: keep current on PATCH when not sent
    }
    // working_days: 0=Sun..6=Sat, deduped+sorted; EMPTY = inherit the site's open_days (never "no days").
    const wdRaw = Array.isArray(body.workingDays) ? body.workingDays : [];
    const workingDays = ([...new Set(wdRaw.map((n: unknown) => Number(n)))] as number[]).filter((n) => Number.isInteger(n) && n >= 0 && n <= 6).sort();

    const startDate = body.startDate === undefined ? undefined : (body.startDate ? parseDay(body.startDate) : null);
    if (body.startDate && startDate === null) return res.status(400).json({ message: 'Enter a valid start date.' });
    // ASYMMETRIC BY DESIGN (ruling 2026-08-02). The column exists so employedDuring's `basis` is
    // uniform at both ends, but the hiring form asks ONE date: pay preceding work effectively does
    // not happen, and a second mandatory date would be filled with the same value every time.
    // Absent = coincides with the start date — a stated default, never "unknown".
    const payStartDate = body.payStartDate === undefined ? undefined : (body.payStartDate ? parseDay(body.payStartDate) : null);
    if (body.payStartDate && payStartDate === null) return res.status(400).json({ message: 'Enter a valid payroll start date.' });

    // Current shape BEFORE the write (tenant guard + the diff base for the dated history).
    let current: (EmploymentShape & { id: string }) | null = null;
    if (isPatch) {
      const owned = (await prisma.costPerson.findFirst({
        where: { id, group_id: groupId },
        select: { id: true, name: true, role: true, amount_pennies: true, cost_type: true, is_chargeable: true, contracted_hours_per_day: true, working_days: true, annual_leave_allowance_days: true, start_date: true, utilisation_factor: true },
      })) as any;
      if (!owned) return res.status(404).json({ message: 'Person not found.' });
      current = { ...owned, contracted_hours_per_day: owned.contracted_hours_per_day == null ? null : Number(owned.contracted_hours_per_day), annual_leave_allowance_days: owned.annual_leave_allowance_days == null ? null : Number(owned.annual_leave_allowance_days), utilisation_factor: owned.utilisation_factor };
    }

    // DUAL-WRITE (record-first invariant): the flat columns update AND the dated events append
    // in ONE transaction — both commit or neither. The flat column stays the head of the series.
    const result = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      const shape: any = { is_chargeable: isChargeable, contracted_hours_per_day: contracted, working_days: workingDays };
      if (factor !== -1) shape.utilisation_factor = factor;
      if (startDate !== undefined) shape.start_date = startDate;
      if (payStartDate !== undefined) shape.pay_start_date = payStartDate;
      const person = isPatch
        ? await tx.costPerson.update({
            where: { id },
            data: { name, role, cost_type: costType as any, amount_pennies: amountPennies, ...shape },
            select: { id: true },
          })
        : await tx.costPerson.create({
            data: { group_id: groupId, name, role, cost_type: costType as any, amount_pennies: amountPennies, ...shape },
            select: { id: true },
          });
      await tx.costAllocation.deleteMany({ where: { cost_person_id: person.id } });
      await tx.costAllocation.createMany({
        data: check.rows.map((r) => ({
          group_id: groupId, site_id: r.siteId, percent: new Prisma.Decimal(r.percent), cost_person_id: person.id,
        })),
      });
      if (isPatch && current) {
        const next: EmploymentShape = {
          name, role,
          amount_pennies: amountPennies, cost_type: costType, is_chargeable: isChargeable,
          contracted_hours_per_day: contracted, working_days: workingDays,
          annual_leave_allowance_days: current.annual_leave_allowance_days, // edited on the Roster, not here
          start_date: startDate === undefined ? current.start_date : startDate,
          utilisation_factor: factor === -1 ? (current as any).utilisation_factor : factor,
        };
        await recordEmploymentEvents(tx, { groupId, costPersonId: person.id, changedBy: vis.userId ?? null, effectiveDate, changes: diffEmploymentShape(current, next) });
      } else if (!isPatch) {
        // New hire: one `started` event anchors the series (effective = start date when given).
        await recordEmploymentEvents(tx, {
          groupId, costPersonId: person.id, changedBy: vis.userId ?? null,
          effectiveDate: startDate ?? effectiveDate,
          changes: [{ kind: 'started', value: { start_date: (startDate ?? effectiveDate).toISOString().slice(0, 10) }, previous: null }],
        });
      }
      return person;
    });

    return res.status(isPatch ? 200 : 201).json({ id: result.id, message: isPatch ? 'Person updated.' : 'Person added.' });
  }

  // ---- DELETE: remove a person (allocations cascade) ----
  if (req.method === 'DELETE') {
    const id = typeof req.query.id === 'string' ? req.query.id : (req.body?.id as string) || '';
    if (!id) return res.status(400).json({ message: 'Missing id.' });
    const del = await prisma.costPerson.deleteMany({ where: { id, group_id: groupId } });
    if (del.count === 0) return res.status(404).json({ message: 'Person not found.' });
    return res.status(200).json({ message: 'Person removed.' });
  }

  res.setHeader('Allow', 'GET, POST, PATCH, DELETE');
  return res.status(405).json({ message: 'Method Not Allowed' });
}
