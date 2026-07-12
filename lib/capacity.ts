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
  // Waterfall grain (ADDITIVE): gross = contracted × rostered days × allocation BEFORE any
  // deduction (non-rostered days never enter it), and the leave subtraction split by type.
  // FRAMING (binding): leave/PH are reductions to CAPACITY, never "lost hours" — they shrink
  // the denominator; what's lost is available − charged.
  grossHours: number;
  leaveByType: Record<string, number>;
};

// THE rostered-day decision moved to lib/rostered-days (ISOMORPHIC — the Headcount form shows
// the inherited default with the same rule). Re-exported here so server importers are unchanged.
export { dayKey, rosteredWeekdays, isRosteredOn } from '@/lib/rostered-days';
import { dayKey, rosteredWeekdays } from '@/lib/rostered-days';
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
      select: { cost_person_id: true, date: true, hours: true, type: true },
    }) as any : [],
    phDaySet(groupId, siteId, window),
  ]);
  const leaveByPerson = new Map<string, Map<string, { hours: number | null; type: string }>>(); // person → day → entry
  for (const l of leave) {
    const m = leaveByPerson.get(l.cost_person_id) ?? new Map();
    m.set(dayKey(l.date), { hours: l.hours == null ? null : Number(l.hours), type: l.type as string });
    leaveByPerson.set(l.cost_person_id, m);
  }

  const days = windowDays(window);
  let centiTotal = 0, centiLeave = 0, centiPh = 0, centiGross = 0, rosteredDays = 0;
  const centiByType: Record<string, number> = {};
  for (const p of configured) {
    const alloc = p.allocations.reduce((s: number, a: any) => s + Number(a.percent), 0) / 100;
    if (alloc <= 0) continue; // not allocated to this site — contributes nothing here
    const contracted = Number(p.contracted_hours_per_day);
    const rostered: number[] = rosteredWeekdays(p.working_days, site?.open_days);
    const myLeave = leaveByPerson.get(p.id);
    let grossC = 0, subC = 0, leaveC = 0, phC = 0;
    const typeC: Record<string, number> = {};
    for (const [key, weekday] of days) {
      if (!rostered.includes(weekday)) continue; // rostered-day guard (weekday from windowDays = isRosteredOn's test)
      rosteredDays += 1;
      grossC += Math.round(contracted * 100);
      if (phDays.has(key)) {
        phC += Math.round(contracted * 100); // PH wins over leave on the same date — a day subtracts once
      } else {
        const entry = myLeave?.get(key);
        if (entry !== undefined) {
          const c = Math.round(Math.min(entry.hours ?? contracted, contracted) * 100); // null = full day; clamp ≤ contracted
          leaveC += c;
          typeC[entry.type] = (typeC[entry.type] ?? 0) + c;
        }
      }
    }
    subC = leaveC + phC;
    const netC = Math.max(0, grossC - subC); // clamp: full-month leave = 0 available, never negative
    centiTotal += Math.round(netC * alloc);
    centiLeave += Math.round(leaveC * alloc);
    centiPh += Math.round(phC * alloc);
    centiGross += Math.round(grossC * alloc);
    for (const [ty, c] of Object.entries(typeC)) centiByType[ty] = (centiByType[ty] ?? 0) + Math.round(c * alloc);
  }

  return {
    hours: centiTotal / 100,
    configComplete: missingHoursMechanics.length === 0,
    missingHoursMechanics,
    mechanicCount: configured.filter((p: any) => p.allocations.reduce((s: number, a: any) => s + Number(a.percent), 0) > 0).length,
    rosteredDays,
    leaveHours: centiLeave / 100,
    phHours: centiPh / 100,
    grossHours: centiGross / 100,
    leaveByType: Object.fromEntries(Object.entries(centiByType).map(([ty, c]) => [ty, c / 100])),
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

/** GROUP utilisation over the caller's visible sites — Σcharged ÷ Σavailable, NEVER a mean of
 *  ratios (a small site's 90% must not average against a big site's 40%). Per-site parts are
 *  returned for the breakdown; missing-hours mechanics + mechanicCount are DISTINCT people
 *  (a split-allocated mechanic counts once, though their rostered days appear under each site). */
export type GroupUtilisation = {
  charged: number; available: number; ratio: number | null;
  configComplete: boolean; missingHoursMechanics: string[];
  mechanicCount: number; rosteredDays: number; leaveHours: number; phHours: number;
  grossHours: number; leaveByType: Record<string, number>; // waterfall grain (see AvailableHours)
  perSite: Array<{ siteId: string; siteName: string; charged: number; available: number; ratio: number | null; rosteredDays: number; leaveHours: number; phHours: number; mechanicCount: number }>;
};

export async function getGroupUtilisation(groupId: string, siteIds: string[], window: CapacityWindow): Promise<GroupUtilisation> {
  const [sites, parts, people] = await Promise.all([
    prisma.site.findMany({ where: { id: { in: siteIds }, group_id: groupId }, orderBy: { created_at: 'asc' }, select: { id: true, site_name: true } }) as any,
    Promise.all(siteIds.map((sid) => getUtilisation(groupId, sid, window))),
    // Distinct-people counts across the visible sites (per-site sums would double-count splits).
    prisma.costPerson.findMany({
      where: { group_id: groupId, is_active: true, is_chargeable: true, allocations: { some: { site_id: { in: siteIds } } } },
      select: { name: true, contracted_hours_per_day: true },
    }) as any,
  ]);
  const nameOf = new Map<string, string>(sites.map((s: any) => [s.id, s.site_name]));
  let charged = 0, available = 0, rosteredDays = 0, leaveHours = 0, phHours = 0, grossHours = 0;
  const leaveByType: Record<string, number> = {};
  const perSite = siteIds.map((sid, i) => {
    const u = parts[i];
    charged += u.charged; available += u.available;
    rosteredDays += u.rosteredDays; leaveHours += u.leaveHours; phHours += u.phHours;
    grossHours += u.grossHours;
    for (const [ty, h] of Object.entries(u.leaveByType)) leaveByType[ty] = Math.round(((leaveByType[ty] ?? 0) + h) * 100) / 100;
    return { siteId: sid, siteName: nameOf.get(sid) ?? '—', charged: u.charged, available: u.available, ratio: u.ratio, rosteredDays: u.rosteredDays, leaveHours: u.leaveHours, phHours: u.phHours, mechanicCount: u.mechanicCount };
  });
  charged = Math.round(charged * 100) / 100; available = Math.round(available * 100) / 100;
  const missingHoursMechanics = people.filter((p: any) => p.contracted_hours_per_day == null).map((p: any) => p.name);
  return {
    charged, available,
    ratio: available === 0 ? null : charged / available, // null → "—", never NaN/Infinity; NOT capped
    configComplete: missingHoursMechanics.length === 0,
    missingHoursMechanics,
    mechanicCount: people.filter((p: any) => p.contracted_hours_per_day != null).length,
    rosteredDays, leaveHours: Math.round(leaveHours * 100) / 100, phHours: Math.round(phHours * 100) / 100,
    grossHours: Math.round(grossHours * 100) / 100, leaveByType,
    perSite,
  };
}
