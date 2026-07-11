/**
 * File: lib/capacity.ts
 * THE capacity chokepoint — the utilisation denominator (hours available, month × site).
 *
 * Formula (net-then-allocate, per binding ruling):
 *   per chargeable+active person:
 *     gross = Σ contracted_hours_per_day over their ROSTERED days in the window
 *     net   = max(0, gross − leave − public holidays)   ← subtractions ONLY on rostered days
 *   site capacity = Σ net × CostAllocation%(person, site)
 * Leave/PH apportion via the SAME allocation % as gross — never by LeaveRecord.site_id
 * (that column is attribution only). A day subtracts AT MOST one full day: a public holiday
 * wins over a leave row on the same date (no double-subtraction).
 *
 * Dates: the window is the SAME {from, to} the charged-hours read uses (UTC month boundaries).
 * All day matching is CALENDAR-date (yyyy-mm-dd of the UTC-midnight stamps, weekday via
 * getUTCDay) — London is never behind UTC, so UTC-midnight stamps align to London calendar
 * dates year-round; comparing on the date (never instants) keeps BST boundaries from
 * shifting or dropping a day.
 *
 * v1 scope: whole-month capacity, no mid-month proration (banked). BANKED GAP: a MULTI-SITE
 * person with EMPTY working_days inherits THIS site's open_days per site — undefined when the
 * sites' open_days differ (both TMBS sites are Mon–Sat, so it doesn't bite). When it arises:
 * require explicit working_days for multi-site people rather than invent a merge rule.
 */
import { prisma } from '@/lib/db';
import { fetchLedgerInvoices, chargedLabourCentihours } from '@/lib/charged-labour';

export type CapacityWindow = { from: Date; to: Date };
export type AvailableHours = {
  hours: number;                     // decimal hours (e.g. 592)
  configComplete: boolean;           // false iff any chargeable person lacks contracted hours
  missingHoursMechanics: string[];   // their names, for the amber flag
  // Popover grain — the arithmetic must be showable, not just the total:
  mechanicCount: number;             // chargeable people contributing (with hours set)
  rosteredDays: number;              // Σ per-person rostered days in the window (config'd people)
  leaveHours: number;                // total subtracted for leave (allocation-scaled)
  phHours: number;                   // total subtracted for public holidays (allocation-scaled)
};

export const dayKey = (d: Date) => d.toISOString().slice(0, 10);

// ---- THE rostered-day decision (one truth — capacity AND leave range-expansion read these;
// never re-derive the inheritance or the weekday test anywhere else) ----
/** A person's rostered weekday set: explicit working_days, else the site's open_days. */
export const rosteredWeekdays = (workingDays: number[], siteOpenDays: number[] | null | undefined): number[] =>
  workingDays.length ? workingDays : (siteOpenDays ?? []);
/** Is calendar date d a rostered (working) day for that weekday set? */
export const isRosteredOn = (rostered: number[], d: Date): boolean => rostered.includes(d.getUTCDay());
/** The window's public-holiday day-keys for a site (group-wide rows + site-specific rows). */
export async function phDaySet(groupId: string, siteId: string, window: CapacityWindow): Promise<Set<string>> {
  const phs = (await prisma.publicHoliday.findMany({
    where: { group_id: groupId, OR: [{ site_id: null }, { site_id: siteId }], date: { gte: window.from, lt: window.to } },
    select: { date: true },
  })) as any[];
  return new Set<string>(phs.map((h) => dayKey(h.date)));
}

/** Enumerate the window's days once: [dayKey, weekday][] (calendar-date grain). */
function windowDays(window: CapacityWindow): Array<[string, number]> {
  const out: Array<[string, number]> = [];
  for (let t = window.from.getTime(); t < window.to.getTime(); t += 86_400_000) {
    const d = new Date(t);
    out.push([dayKey(d), d.getUTCDay()]);
  }
  return out;
}

export async function getAvailableHours(groupId: string, siteId: string, window: CapacityWindow): Promise<AvailableHours> {
  const [site, people] = await Promise.all([
    prisma.site.findFirst({ where: { id: siteId, group_id: groupId }, select: { open_days: true } }) as any,
    prisma.costPerson.findMany({
      where: { group_id: groupId, is_active: true, is_chargeable: true },
      select: {
        id: true, name: true, contracted_hours_per_day: true, working_days: true,
        allocations: { where: { site_id: siteId }, select: { percent: true } },
      },
    }) as any,
  ]);
  const missingHoursMechanics = people.filter((p: any) => p.contracted_hours_per_day == null).map((p: any) => p.name);
  const configured = people.filter((p: any) => p.contracted_hours_per_day != null);
  const ids = configured.map((p: any) => p.id);

  const [leave, phDays] = await Promise.all([
    ids.length ? prisma.leaveRecord.findMany({
      where: { group_id: groupId, cost_person_id: { in: ids }, status: 'approved', date: { gte: window.from, lt: window.to } },
      select: { cost_person_id: true, date: true, hours: true },
    }) as any : [],
    phDaySet(groupId, siteId, window),
  ]);
  const leaveByPerson = new Map<string, Map<string, number | null>>(); // person → day → hours (null = full day)
  for (const l of leave) {
    const m = leaveByPerson.get(l.cost_person_id) ?? new Map();
    m.set(dayKey(l.date), l.hours == null ? null : Number(l.hours));
    leaveByPerson.set(l.cost_person_id, m);
  }

  const days = windowDays(window);
  let centiTotal = 0, centiLeave = 0, centiPh = 0, rosteredDays = 0;
  for (const p of configured) {
    const alloc = p.allocations.reduce((s: number, a: any) => s + Number(a.percent), 0) / 100;
    if (alloc <= 0) continue; // not allocated to this site — contributes nothing here
    const contracted = Number(p.contracted_hours_per_day);
    const rostered: number[] = rosteredWeekdays(p.working_days, site?.open_days);
    const myLeave = leaveByPerson.get(p.id);
    let grossC = 0, subC = 0, leaveC = 0, phC = 0;
    for (const [key, weekday] of days) {
      if (!rostered.includes(weekday)) continue; // rostered-day guard (weekday from windowDays = isRosteredOn's test)
      rosteredDays += 1;
      grossC += Math.round(contracted * 100);
      if (phDays.has(key)) {
        phC += Math.round(contracted * 100); // PH wins over leave on the same date — a day subtracts once
      } else {
        const lh = myLeave?.get(key);
        if (lh !== undefined) leaveC += Math.round(Math.min(lh ?? contracted, contracted) * 100); // null = full day; clamp ≤ contracted
      }
    }
    subC = leaveC + phC;
    const netC = Math.max(0, grossC - subC); // clamp: full-month leave = 0 available, never negative
    centiTotal += Math.round(netC * alloc);
    centiLeave += Math.round(leaveC * alloc);
    centiPh += Math.round(phC * alloc);
  }

  return {
    hours: centiTotal / 100,
    configComplete: missingHoursMechanics.length === 0,
    missingHoursMechanics,
    mechanicCount: configured.filter((p: any) => p.allocations.reduce((s: number, a: any) => s + Number(a.percent), 0) > 0).length,
    rosteredDays,
    leaveHours: centiLeave / 100,
    phHours: centiPh / 100,
  };
}

// ---------- Utilisation = hours charged ÷ hours available (month × site) ----------
// Numerator = the P&L's OWN charged-hours read (lib/charged-labour — extracted, not re-queried),
// called single-site. Denominator = getAvailableHours. BOTH receive the SAME window object —
// numerator and denominator share identical boundaries by construction (the one-truth rail).
// Group aggregation is Σcharged ÷ Σavailable (never a mean of ratios) — callers sum the parts.
export type Utilisation = AvailableHours & {
  charged: number;          // decimal hours charged in the window (this site)
  available: number;        // = hours (aliased for the tile's charged ÷ available framing)
  ratio: number | null;     // charged/available; NULL when available === 0 (render "—", never NaN).
                            // NOT capped at 100% — over-capacity months must show as >100%.
};

export async function getUtilisation(groupId: string, siteId: string, window: CapacityWindow): Promise<Utilisation> {
  const [invoices, avail] = await Promise.all([
    fetchLedgerInvoices({ groupId, siteIds: [siteId], from: window.from, to: window.to }),
    getAvailableHours(groupId, siteId, window),
  ]);
  const charged = chargedLabourCentihours(invoices).centihours / 100;
  return {
    ...avail,
    charged,
    available: avail.hours,
    // configComplete=false does NOT suppress the ratio: a chargeable tech with no contracted
    // hours contributes 0 available, so the ratio is UPWARD-biased — show it flagged amber
    // (popover names missingHoursMechanics), never hidden.
    ratio: avail.hours === 0 ? null : charged / avail.hours,
  };
}
