/**
 * File: lib/roster.ts
 * THE Roster read — role-scoped leave/allowance data, server-enforced through the same
 * Visibility the rest of the app uses (never client-gated). Extracted from the API so the
 * verification matrix can drive the scoping with synthetic Visibility objects.
 *
 * TWO POPULATIONS — deliberate: the Roster lists ALL active employees (everyone gets holidays);
 * only is_chargeable people feed the utilisation denominator (lib/capacity). Do not narrow this
 * list to chargeable staff.
 *
 * Leave is PERSON-GLOBAL: rows live on the person; LeaveRecord.site_id is attribution metadata
 * only. Capacity apportionment across sites happens in getAvailableHours via CostAllocation %,
 * never here — and allowance/taken/balance are per-person figures, never apportioned or summed
 * across sites.
 *
 * Balance maths (v1, binding): leave-year = CALENDAR year, no carry-over (banked).
 * taken = Σ this year's rows: full-day row = 1 day; hours-override = hours ÷ contracted (pro-rated).
 * closure-type rows count like any other leave — the closure consumes the grant BY DESIGN.
 */
import { prisma } from '@/lib/db';
import type { Visibility } from '@/lib/site-visibility';
import { rosteredWeekdays, isRosteredOn, dayKey } from '@/lib/capacity';
import { DEDUCTS_ALLOWANCE, LeaveTypeKey } from '@/lib/leave-types';

export type RosterLeaveRow = {
  id: string; date: string; hours: number | null; type: string; status: string; siteId: string;
  batchId: string | null; // rows of one range booking share this; null = legacy/ad-hoc row
};

// ---- Range expansion planner (PURE — the API expands with it; the matrix drives it) ----
// For each calendar day start→end inclusive: book a FULL-day row iff it's a working day for the
// person (THE capacity rostered-day helpers — one truth, never re-derived) AND not a bank
// holiday AND not already booked. Skips are REPORTED per-day with a reason, never silent:
// the range's deducted count must always be explainable.
export type SkipReason = 'notWorkingDay' | 'bankHoliday' | 'alreadyBooked';
export type LeavePlan = { book: string[]; skipped: Array<{ date: string; reason: SkipReason }> };
export function planLeaveRange(
  start: Date, end: Date,
  personWorkingDays: number[], siteOpenDays: number[] | null | undefined,
  phDays: Set<string>, alreadyBookedDays: Set<string>,
): LeavePlan {
  const rostered = rosteredWeekdays(personWorkingDays, siteOpenDays);
  const book: string[] = [];
  const skipped: Array<{ date: string; reason: SkipReason }> = [];
  for (let t = start.getTime(); t <= end.getTime(); t += 86_400_000) {
    const d = new Date(t);
    const key = dayKey(d);
    if (!isRosteredOn(rostered, d)) skipped.push({ date: key, reason: 'notWorkingDay' });
    else if (phDays.has(key)) skipped.push({ date: key, reason: 'bankHoliday' });
    else if (alreadyBookedDays.has(key)) skipped.push({ date: key, reason: 'alreadyBooked' });
    else book.push(key);
  }
  return { book, skipped };
}
export type RosterPerson = {
  id: string;
  name: string;
  role: string | null;
  isChargeable: boolean;
  contractedHoursPerDay: number | null;
  allowanceDays: number | null;
  takenDays: number;
  balanceDays: number | null; // null when allowance is null
  homeSiteId: string | null;
  alsoAtSiteIds: string[];
  isSelf: boolean;
  editable: boolean; // server-decided; the API re-checks on every write regardless
  leave: RosterLeaveRow[];
};
export type Roster = {
  people: RosterPerson[];
  sites: Array<{ id: string; name: string }>;
  canWrite: boolean;    // any-write capability (admin or manager) — per-person editable still applies
  canEditAllowance: boolean; // ADMIN only
  year: number;
};

const dayISO = (d: Date) => d.toISOString().slice(0, 10);

/** Home site = highest CostAllocation %; ties broken by percent DESC then site created_at ASC
 *  (deterministic + stable across reloads — approved tie-break). */
function homeSite(allocs: Array<{ site_id: string; percent: number; created: number }>): { home: string | null; also: string[] } {
  if (!allocs.length) return { home: null, also: [] };
  const sorted = [...allocs].sort((a, b) => (b.percent - a.percent) || (a.created - b.created));
  return { home: sorted[0].site_id, also: sorted.slice(1).map((a) => a.site_id) };
}

export async function buildRoster(groupId: string, vis: Visibility, year: number): Promise<Roster> {
  const yearFrom = new Date(Date.UTC(year, 0, 1));
  const yearTo = new Date(Date.UTC(year + 1, 0, 1));

  const sites = (await prisma.site.findMany({
    where: { group_id: groupId }, orderBy: { created_at: 'asc' },
    select: { id: true, site_name: true, created_at: true },
  })) as any[];
  const siteCreated = new Map<string, number>(sites.map((s: any) => [s.id, s.created_at.getTime()]));

  const all = (await prisma.costPerson.findMany({
    where: { group_id: groupId, is_active: true },
    orderBy: { name: 'asc' },
    select: {
      id: true, name: true, role: true, user_id: true, is_chargeable: true,
      contracted_hours_per_day: true, annual_leave_allowance_days: true,
      allocations: { select: { site_id: true, percent: true } },
      leave: { where: { date: { gte: yearFrom, lt: yearTo } }, orderBy: { date: 'asc' }, select: { id: true, date: true, hours: true, type: true, status: true, site_id: true, leave_batch_id: true } },
    },
  })) as any[];

  // Role scoping (server truth): ADMIN = everyone; SITE_MANAGER = people allocated to their
  // manageable sites PLUS their own record; STANDARD = own record only (read-only).
  const isSelf = (p: any) => !!p.user_id && p.user_id === vis.userId;
  const inManagedSite = (p: any) => p.allocations.some((a: any) => vis.siteIds.includes(a.site_id));
  let visible: any[];
  if (vis.isAdmin) visible = all;
  else if (vis.role === 'SITE_MANAGER') visible = all.filter((p) => inManagedSite(p) || isSelf(p));
  else visible = all.filter(isSelf);

  const people: RosterPerson[] = visible.map((p) => {
    const contracted = p.contracted_hours_per_day == null ? null : Number(p.contracted_hours_per_day);
    const allowance = p.annual_leave_allowance_days == null ? null : Number(p.annual_leave_allowance_days);
    // taken: full day = 1; hours-override pro-rated against contracted (writes reject an
    // override when contracted is unset, so the fallback below only guards legacy rows).
    // ONLY allowance-deducting types move the balance (lib/leave-types DEDUCTS_ALLOWANCE —
    // annual + closure). sick/compassionate/parental/training/other still show in the list AND
    // still drop capacity (getAvailableHours is type-blind by design) but are allowance-neutral.
    let taken = 0;
    for (const l of p.leave) {
      if (!DEDUCTS_ALLOWANCE[l.type as LeaveTypeKey]) continue;
      taken += l.hours == null ? 1 : (contracted ? Number(l.hours) / contracted : 1);
    }
    taken = Math.round(taken * 100) / 100;
    const { home, also } = homeSite(p.allocations.map((a: any) => ({ site_id: a.site_id, percent: Number(a.percent), created: siteCreated.get(a.site_id) ?? 0 })));
    const self = isSelf(p);
    return {
      id: p.id, name: p.name, role: p.role ?? null,
      isChargeable: p.is_chargeable,
      contractedHoursPerDay: contracted,
      allowanceDays: allowance,
      takenDays: taken,
      balanceDays: allowance == null ? null : Math.round((allowance - taken) * 100) / 100,
      homeSiteId: home, alsoAtSiteIds: also,
      isSelf: self,
      editable: vis.isAdmin || (vis.role === 'SITE_MANAGER' && inManagedSite(p)),
      leave: p.leave.map((l: any) => ({ id: l.id, date: dayISO(l.date), hours: l.hours == null ? null : Number(l.hours), type: l.type, status: l.status, siteId: l.site_id, batchId: l.leave_batch_id ?? null })),
    };
  });

  return {
    people,
    sites: sites.map((s: any) => ({ id: s.id, name: s.site_name })),
    canWrite: vis.isAdmin || vis.role === 'SITE_MANAGER',
    canEditAllowance: vis.isAdmin,
    year,
  };
}

/** Server-side write permission for a person's leave — the API calls this on EVERY mutation. */
export async function canEditPersonLeave(groupId: string, vis: Visibility, costPersonId: string): Promise<{ ok: boolean; person?: any }> {
  const person = (await prisma.costPerson.findFirst({
    where: { id: costPersonId, group_id: groupId, is_active: true },
    select: { id: true, user_id: true, contracted_hours_per_day: true, allocations: { select: { site_id: true, percent: true } } },
  })) as any;
  if (!person) return { ok: false };
  if (vis.isAdmin) return { ok: true, person };
  if (vis.role === 'SITE_MANAGER' && person.allocations.some((a: any) => vis.siteIds.includes(a.site_id))) return { ok: true, person };
  return { ok: false };
}
