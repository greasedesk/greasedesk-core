/**
 * File: lib/capacity.ts
 * THE capacity chokepoint — the utilisation denominator (SELLABLE hours, month × site).
 *
 * Formula (net-then-allocate, then factor-discount — per binding ruling 2026-07-12):
 *   per chargeable+active person:
 *     gross    = Σ contracted_hours_per_day over their ROSTERED days in the window
 *     raw      = max(0, gross − leave − public holidays)   ← subtractions ONLY on rostered days
 *     sellable = raw × utilisation_factor (as of the window end — the value-true-at-time read)
 *   site capacity = Σ sellable × CostAllocation%(person, site)
 * THE MODEL: the factor is a SPEED expectation, not an attendance one — an apprentice at 50%
 * converts half his clock time into billable work, so his 8 rostered hours are ~4 sellable.
 * `hours`/`available` everywhere downstream MEANS sellable; utilisation = charged ÷ sellable,
 * so 100% is the target BY CONSTRUCTION (billing exactly to expectation reads as 100%).
 * ORDER IS BINDING: absence reduces RAW hours first, the factor discounts what remains —
 * never apply the factor to leave/PH (a day off isn't 50% of a day off), never double-count.
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
 * EMPLOYMENT WINDOW (ruling 2026-08-01): a person contributes capacity only for months they were
 * actually employed. `start_date`/`end_date` existed on CostPerson and were UNREAD — Ta'Harie
 * Samuels, starting 2026-06-01, was adding 106.40h / £7,980 to MAY. Overlap test, inclusive at both
 * ends: started on or before the window END, and not ended before the window START.
 *   NULL start_date  = UNKNOWN, and unknown is INCLUDED — but never silently. Excluding would
 *     delete a real person's capacity on the strength of a missing field, which under-reports the
 *     denominator and so FLATTERS utilisation; including over-reports it and is visible. The names
 *     come back as `unknownStartPeople` and the dashboard flags them, exactly as it already flags
 *     mechanics missing contracted hours. Census at the time of the ruling: 0 of 4 CostPerson rows
 *     across all tenants had a null start_date, so this is a guard, not a live behaviour change.
 *   NULL work_end_date = still employed. That one is not ambiguous.
 * TWO DATES AT EACH END (2026-08-02): work_end_date drives capacity, pay_end_date drives cost —
 * payment in lieu is the case a single leaving date cannot express. See employedDuring's `basis`.
 *
 * v1 scope: whole-month capacity, no mid-month proration (banked). NOT PRORATED, deliberately and
 * consistently with that: someone who starts mid-month contributes their WHOLE month. The overlap
 * test is month-grained like everything else here; proration is one change, in one place, later.
 * BANKED GAP: a MULTI-SITE
 * person with EMPTY working_days inherits THIS site's open_days per site — undefined when the
 * sites' open_days differ (both TMBS sites are Mon–Sat, so it doesn't bite). When it arises:
 * require explicit working_days for multi-site people rather than invent a merge rule.
 */
import { prisma } from '@/lib/db';
import { fetchLedgerInvoices, chargedLabourCentihours } from '@/lib/charged-labour';

export type CapacityWindow = { from: Date; to: Date };
export type AvailableHours = {
  hours: number;                     // SELLABLE decimal hours (factor-adjusted) — THE denominator
  rawHours: number;                  // pre-factor clock time: rostered × contracted − leave − PH (alloc-scaled)
  configComplete: boolean;           // false iff any chargeable person lacks contracted hours
  missingHoursMechanics: string[];   // their names, for the amber flag
  // Included DESPITE an unknown start date — surfaced, never silently counted (see header).
  unknownStartPeople: string[];
  // People whose dated event carried a value the validator REFUSED. They fell back to today's
  // column — which is the old bug — so the fallback is NEVER silent.
  malformedEvents: string[];
  // Popover grain — the arithmetic must be showable, not just the total:
  mechanicCount: number;             // chargeable people contributing (with hours set)
  // WHO those people are. Carried so the group roll-up can take a DISTINCT union across sites
  // instead of running its own census — see getGroupUtilisation.
  countedPeople: string[];
  rosteredDays: number;              // Σ per-person rostered days in the window (config'd people)
  leaveHours: number;                // total subtracted for leave (allocation-scaled, CLOCK time — never factored)
  phHours: number;                   // total subtracted for public holidays (allocation-scaled, CLOCK time)
  // Waterfall grain (ADDITIVE): gross = contracted × rostered days × allocation BEFORE any
  // deduction (non-rostered days never enter it), and the leave subtraction split by type.
  // FRAMING (binding): leave/PH are reductions to CAPACITY, never "lost hours" — they shrink
  // raw hours; the factor then discounts raw to sellable; what's lost (unsold) is
  // sellable − charged − rework (see dashboard.tsx unsold tile). Rework is subtracted because
  // those hours were SPENT (redoing work for free), not idle — counting them as unsold would
  // overstate the opportunity (ruling 2026-07-12, which excludes rework from `charged` too).
  grossHours: number;
  leaveByType: Record<string, number>;
  // THE SAME absences in DAYS, accumulated in the same loop (see the loop comment). The manpower
  // row renders these; hours remain the capacity currency. Never re-derive one from the other.
  leaveDaysByType: Record<string, number>;
  // Days the site was open and the person employed, but not in their rostered pattern — day
  // release AND part-time, deliberately not distinguished. Allocation-scaled like everything else.
  nonRosteredDays: number;
  // FACTOR exposition (computed, never typed): per person, raw × factor = sellable. The factor
  // is resolved AS OF THE WINDOW END from the EmploymentEvent series (value-true-at-time —
  // historic months keep the factor that applied then; changing it today never moves last
  // month's utilisation). The factor is a workshop expectation, NEVER an individual score —
  // no per-person actuals exist or may be added.
  factorParts: Array<{ name: string; rawHours: number; factorPct: number; sellableHours: number }>;
};

// THE rostered-day decision moved to lib/rostered-days (ISOMORPHIC — the Headcount form shows
// the inherited default with the same rule). Re-exported here so server importers are unchanged.
export { dayKey, rosteredWeekdays, isRosteredOn } from '@/lib/rostered-days';
import { dayKey, rosteredWeekdays } from '@/lib/rostered-days';
import { openDaysAtWindowEnd } from '@/lib/site-config';
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

/**
 * WHO COUNTS, in one place. Three separate queries in this file select the contributing people —
 * getAvailableHours, getDailyCapacity and the group roll-up — and a rule written three times is a
 * rule that will eventually disagree with itself. The daily accrual line MUST select the same
 * people as the total, or the chart and its own callout stop reconciling.
 *
 * EMPLOYED DURING THE WINDOW (overlap; nulls unbounded — see header). NOT chargeable —
 * `is_chargeable` is itself an effective-dated attribute now, so it is resolved per window in JS
 * rather than filtered in SQL, where a historic value cannot be seen.
 *
 * ── `is_active` IS NOT HERE, DELIBERATELY (ruling 2026-08-02) ───────────────────────────────────
 * It used to be, and it made `work_end_date` dead code: marking someone left sets is_active=false,
 * which failed this clause for EVERY window, so a leaver's capacity and gross pay vanished from
 * months they demonstrably worked. Proven on the served build before the fix — a ZZ person left on
 * 31 July deleted 176.00h and £2,000.00 from the previous JUNE. A current-state flag cannot answer
 * a historic question. It stays on the HR current-employees list and the roster's live view;
 * NOTHING that computes a historic figure may reference it.
 *
 * ── ONE CLAUSE, TWO BASES ──────────────────────────────────────────────────────────────────────
 * `basis` picks WHICH pair of dates bounds the window and nothing else. Everything that makes this
 * the shared rule stays common across both: tenant scope, the overlap shape, inclusive at both
 * ends, null start = unknown = included-and-flagged, month-grained and unprorated.
 *   'work' → start_date … work_end_date   — CAPACITY. No sellable hours after the last working day.
 *   'pay'  → pay_start   … pay_end        — COST. The P&L carries them to the last PAID day.
 * A null pay_* coincides with its work counterpart (a stated default — see the schema), which is
 * why each side is a two-branch OR rather than a single column read.
 */
export type EmploymentBasis = 'work' | 'pay';

export function employedDuring(groupId: string, window: CapacityWindow, basis: EmploymentBasis = 'work') {
  // Started on or before the window END. `pay_start_date ?? start_date` expressed as SQL: either
  // the payroll date is set and governs, or it is absent and the working date does.
  const startedBefore = basis === 'pay'
    ? [{ pay_start_date: { lt: window.to } },
       { AND: [{ pay_start_date: null }, { OR: [{ start_date: null }, { start_date: { lt: window.to } }] }] }]
    : [{ start_date: null }, { start_date: { lt: window.to } }];
  // Not ended before the window START. Unset = still here on that basis.
  const notEndedBefore = basis === 'pay'
    ? [{ pay_end_date: { gte: window.from } },
       { AND: [{ pay_end_date: null }, { OR: [{ work_end_date: null }, { work_end_date: { gte: window.from } }] }] }]
    : [{ work_end_date: null }, { work_end_date: { gte: window.from } }];
  return {
    group_id: groupId,
    AND: [{ OR: startedBefore }, { OR: notEndedBefore }],
  };
}

/**
 * THE SAME RULE AS `employedDuring`, IN MEMORY.
 *
 * Two forms of one rule is a divergence waiting to happen, so they sit together and
 * wage-per-month-gate pins that they agree on the boundary cases. The in-memory form exists because
 * a per-month payroll would otherwise cost one query per month per site: monthlyWageBill fetches
 * the window's people once and asks this question twelve times.
 *
 * Read it against the SQL above line for line — started on or before the window end, not ended
 * before the window start, with `pay_*` governing when set and the working dates when not.
 */
export function isEmployedDuring(
  p: { start_date: Date | null; pay_start_date?: Date | null; work_end_date: Date | null; pay_end_date?: Date | null },
  window: CapacityWindow,
  basis: EmploymentBasis = 'work',
): boolean {
  const start = basis === 'pay' ? (p.pay_start_date ?? p.start_date) : p.start_date;
  const end = basis === 'pay' ? (p.pay_end_date ?? p.work_end_date) : p.work_end_date;
  const startedBefore = start == null || start.getTime() < window.to.getTime();
  const notEndedBefore = end == null || end.getTime() >= window.from.getTime();
  return startedBefore && notEndedBefore;
}

export async function getAvailableHours(groupId: string, siteId: string, window: CapacityWindow): Promise<AvailableHours> {
  const [site, people] = await Promise.all([
    prisma.site.findFirst({ where: { id: siteId, group_id: groupId }, select: { open_days: true } }) as any,
    prisma.costPerson.findMany({
      where: employedDuring(groupId, window),
      select: {
        id: true, name: true, contracted_hours_per_day: true, working_days: true, utilisation_factor: true,
        is_chargeable: true, start_date: true, work_end_date: true,
        allocations: { where: { site_id: siteId }, select: { percent: true } },
      },
    }) as any,
  ]);
  // OPEN DAYS AS OF THE WINDOW END, not today's flat column. The site's trading pattern is
  // effective-dated (lib/site-config) exactly as the utilisation factor is: a historic month keeps
  // the pattern that applied THEN, so changing trading days today never moves last month's
  // capacity. The flat column remains the fallback when no change has ever been recorded.
  const openDaysAtT: number[] = await openDaysAtWindowEnd(siteId, window.to, site?.open_days);

  // EVERY effective-dated attribute resolved AS OF THE WINDOW, from one resolver. Reading the flat
  // column here is what put May 2026 on a five-day week and 8.5h when the events said four days
  // and 8h. `started`/`ended` stay on the flat column deliberately — a start date is a fact being
  // corrected, not a value that varies over time.
  const allIds = people.map((p: any) => p.id);
  const [patternR, hoursR, chargeableR, factorR] = await Promise.all([
    valuesAtWindowEnd<number[]>(allIds, window.to, 'pattern', 'working_days', isWeekdayArray),
    valuesAtWindowEnd<number>(allIds, window.to, 'hours', 'contracted_hours_per_day', isFiniteNumber),
    valuesAtWindowEnd<boolean>(allIds, window.to, 'chargeable', 'is_chargeable', isBooleanValue),
    valuesAtWindowEnd<number>(allIds, window.to, 'factor', 'utilisation_factor', isFiniteNumber),
  ]);
  const nameOfId = new Map<string, string>(people.map((p: any) => [p.id, p.name]));
  const malformedEvents = [...new Set([...patternR.malformed, ...hoursR.malformed, ...chargeableR.malformed, ...factorR.malformed])]
    .map((id) => nameOfId.get(id) ?? id);
  // Per-person resolved reads (event value, else today's column).
  const hoursOf = (p: any) => { const v = hoursR.values.get(p.id); return v ?? (p.contracted_hours_per_day == null ? null : Number(p.contracted_hours_per_day)); };
  const patternOf = (p: any) => patternR.values.get(p.id) ?? (p.working_days as number[]);
  const chargeableOf = (p: any) => chargeableR.values.get(p.id) ?? !!p.is_chargeable;

  const chargeable = people.filter(chargeableOf);
  const missingHoursMechanics = chargeable.filter((p: any) => hoursOf(p) == null).map((p: any) => p.name);
  // Counted, but say so. An unknown start is a data gap the garage can close, not a fact.
  const unknownStartPeople = chargeable.filter((p: any) => p.start_date == null).map((p: any) => p.name);
  const configured = chargeable.filter((p: any) => hoursOf(p) != null);
  const countedPeople = configured
    .filter((p: any) => p.allocations.reduce((s: number, a: any) => s + Number(a.percent), 0) > 0)
    .map((p: any) => p.name as string);
  const ids = configured.map((p: any) => p.id);
  const factorAt = factorR.values;

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
  let centiSellable = 0, centiRaw = 0, centiLeave = 0, centiPh = 0, centiGross = 0, rosteredDays = 0;
  const centiByType: Record<string, number> = {};
  // DAY-UNIT GRAIN FOR THE MANPOWER ROW, accumulated in THIS loop rather than re-derived in a
  // second file — the rostered-day test, the PH-wins rule and the part-day clamp are the same
  // decisions, and a second copy is how they eventually disagree. Days are allocation-scaled for
  // the same reason hours are: a person split across sites contributes one day in total, not one
  // per site. milli-days (×1000) so a half-day at a 7.5h contract stays exact under addition.
  const milliDaysByType: Record<string, number> = {};
  // The PATTERN GAP: days this site was OPEN and the person employed, but not in their rostered
  // pattern. This is college day release AND genuine part-time patterns — the tile must not claim
  // to tell them apart. It is the largest invisible deduction from TMBS sellable hours, and it
  // never appears as leave because capacity expresses it as the absence of a rostered day.
  let milliNonRostered = 0;
  const factorParts: Array<{ name: string; rawHours: number; factorPct: number; sellableHours: number }> = [];
  for (const p of configured) {
    const alloc = p.allocations.reduce((s: number, a: any) => s + Number(a.percent), 0) / 100;
    if (alloc <= 0) continue; // not allocated to this site — contributes nothing here
    const contracted = Number(hoursOf(p));
    const rostered: number[] = rosteredWeekdays(patternOf(p), openDaysAtT);
    const myLeave = leaveByPerson.get(p.id);
    let grossC = 0, subC = 0, leaveC = 0, phC = 0;
    const typeC: Record<string, number> = {};
    for (const [key, weekday] of days) {
      if (!rostered.includes(weekday)) {
        // Open here but not rostered for them = the pattern gap. Public holidays are excluded:
        // the site is shut, so nobody's pattern could have covered it and it is not a gap.
        if (openDaysAtT.includes(weekday) && !phDays.has(key)) milliNonRostered += Math.round(1000 * alloc);
        continue; // rostered-day guard (weekday from windowDays = isRosteredOn's test)
      }
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
          // The SAME consumed day, counted in days: the fraction of a contracted day it took.
          milliDaysByType[entry.type] = (milliDaysByType[entry.type] ?? 0) + Math.round((c / (contracted * 100)) * 1000 * alloc);
        }
      }
    }
    subC = leaveC + phC;
    const netC = Math.max(0, grossC - subC); // clamp: full-month leave = 0 raw, never negative
    const personRawC = Math.round(netC * alloc);
    // The factor discounts RAW (post-absence) hours to sellable — order is binding (see header).
    const factorPct = factorAt.get(p.id) ?? Number(p.utilisation_factor ?? 70);
    const personSellableC = Math.round(personRawC * (factorPct / 100));
    centiRaw += personRawC;
    centiSellable += personSellableC;
    centiLeave += Math.round(leaveC * alloc);
    centiPh += Math.round(phC * alloc);
    centiGross += Math.round(grossC * alloc);
    for (const [ty, c] of Object.entries(typeC)) centiByType[ty] = (centiByType[ty] ?? 0) + Math.round(c * alloc);
    if (personRawC > 0) factorParts.push({ name: p.name, rawHours: personRawC / 100, factorPct, sellableHours: personSellableC / 100 });
  }

  return {
    hours: centiSellable / 100,
    rawHours: centiRaw / 100,
    configComplete: missingHoursMechanics.length === 0,
    missingHoursMechanics,
    unknownStartPeople,
    malformedEvents,
    mechanicCount: countedPeople.length,
    countedPeople,
    rosteredDays,
    leaveHours: centiLeave / 100,
    phHours: centiPh / 100,
    grossHours: centiGross / 100,
    leaveByType: Object.fromEntries(Object.entries(centiByType).map(([ty, c]) => [ty, c / 100])),
    leaveDaysByType: Object.fromEntries(Object.entries(milliDaysByType).map(([ty, m]) => [ty, m / 1000])),
    nonRosteredDays: milliNonRostered / 1000,
    factorParts,
  };
}

export type DailyCapacityPoint = { dayKey: string; cumulativeSellable: number };
export type DailyCapacity = { days: DailyCapacityPoint[]; total: number; perSite: Array<{ siteId: string; sellable: number }> };

/** CAPACITY ACCRUAL, day by day — the burn-up "capacity pace" line. Sellable hours accrue ONLY on
 *  rostered working days (flat across weekends / bank holidays / closed days / leave), reaching the
 *  month's full sellable total on the last working day. Reuses THE capacity math VERBATIM (same
 *  per-person nested rounding as getAvailableHours), so the final cumulative === getAvailableHours.hours
 *  by construction (gated). Single pass over sites × people × days — no per-day re-query. */
export async function getDailyCapacity(groupId: string, siteIds: string[], window: CapacityWindow): Promise<DailyCapacity> {
  const days = windowDays(window); // ordered [dayKey, weekday] across the whole window
  const groupCumulCenti = new Array<number>(days.length).fill(0);
  const perSite: Array<{ siteId: string; sellable: number }> = [];

  for (const siteId of siteIds) {
    const [site, people] = await Promise.all([
      prisma.site.findFirst({ where: { id: siteId, group_id: groupId }, select: { open_days: true } }) as any,
      prisma.costPerson.findMany({
        // SAME clause as getAvailableHours — the accrual line must not select a different set of
        // people from the total it is supposed to reach.
        where: employedDuring(groupId, window),
        select: { id: true, contracted_hours_per_day: true, working_days: true, utilisation_factor: true, is_chargeable: true, allocations: { where: { site_id: siteId }, select: { percent: true } } },
      }) as any,
    ]);
    const openDaysAtT: number[] = await openDaysAtWindowEnd(siteId, window.to, site?.open_days);
    // THE SAME RESOLUTION as getAvailableHours. The accrual line is documented to reach the total
    // exactly; resolving one and not the other would make the chart disagree with its own callout.
    const allIds = people.map((p: any) => p.id);
    const [patternR, hoursR, chargeableR, factorR] = await Promise.all([
      valuesAtWindowEnd<number[]>(allIds, window.to, 'pattern', 'working_days', isWeekdayArray),
      valuesAtWindowEnd<number>(allIds, window.to, 'hours', 'contracted_hours_per_day', isFiniteNumber),
      valuesAtWindowEnd<boolean>(allIds, window.to, 'chargeable', 'is_chargeable', isBooleanValue),
      valuesAtWindowEnd<number>(allIds, window.to, 'factor', 'utilisation_factor', isFiniteNumber),
    ]);
    const hoursOf = (p: any) => { const v = hoursR.values.get(p.id); return v ?? (p.contracted_hours_per_day == null ? null : Number(p.contracted_hours_per_day)); };
    const patternOf = (p: any) => patternR.values.get(p.id) ?? (p.working_days as number[]);
    const chargeableOf = (p: any) => chargeableR.values.get(p.id) ?? !!p.is_chargeable;
    const configured = people.filter((p: any) => chargeableOf(p) && hoursOf(p) != null);
    const ids = configured.map((p: any) => p.id);
    const [factorAt, leave, phDays] = await Promise.all([
      Promise.resolve(factorR.values),
      ids.length ? prisma.leaveRecord.findMany({
        where: { group_id: groupId, cost_person_id: { in: ids }, status: 'approved', date: { gte: window.from, lt: window.to } },
        select: { cost_person_id: true, date: true, hours: true },
      }) as any : [],
      phDaySet(groupId, siteId, window),
    ]);
    const leaveByPerson = new Map<string, Map<string, number | null>>();
    for (const l of leave) {
      const m = leaveByPerson.get(l.cost_person_id) ?? new Map();
      m.set(dayKey(l.date), l.hours == null ? null : Number(l.hours));
      leaveByPerson.set(l.cost_person_id, m);
    }

    for (const p of configured) {
      const alloc = p.allocations.reduce((s: number, a: any) => s + Number(a.percent), 0) / 100;
      if (alloc <= 0) continue;
      const contracted = Number(hoursOf(p));
      const rostered: number[] = rosteredWeekdays(patternOf(p), openDaysAtT);
      const factorPct = factorAt.get(p.id) ?? Number(p.utilisation_factor ?? 70);
      const myLeave = leaveByPerson.get(p.id);
      // Running gross/leave/PH in centihours; at each day the person's cumulative sellable is
      // round(round(netC × alloc) × factor) — the SAME nesting getAvailableHours applies at month end.
      let grossC = 0, leaveC = 0, phC = 0;
      for (let i = 0; i < days.length; i++) {
        const [key, weekday] = days[i];
        if (rostered.includes(weekday)) {
          grossC += Math.round(contracted * 100);
          if (phDays.has(key)) phC += Math.round(contracted * 100);
          else if (myLeave?.has(key)) { const h = myLeave.get(key); leaveC += Math.round(Math.min(h ?? contracted, contracted) * 100); }
        }
        const netC = Math.max(0, grossC - leaveC - phC);
        const personSellableC = Math.round(Math.round(netC * alloc) * (factorPct / 100));
        groupCumulCenti[i] += personSellableC;
      }
    }
    // Per-site full-month sellable (last cumulative point for THIS site) — recomputed compactly for
    // the potential-revenue valuation; equals getAvailableHours(site).hours by construction.
    const sh = await getAvailableHours(groupId, siteId, window);
    perSite.push({ siteId, sellable: sh.hours });
  }

  return {
    days: days.map(([dk], i) => ({ dayKey: dk, cumulativeSellable: Math.round(groupCumulCenti[i]) / 100 })),
    total: Math.round(groupCumulCenti[days.length - 1] ?? 0) / 100,
    perSite,
  };
}

/** The factor value AS OF window end, per person — the system's first value-true-at-time read.
 *  Resolution: latest non-voided `factor` event with effective_date < T → its value; else, if a
 *  LATER event exists, the EARLIEST later event's previous_json (the value that applied before
 *  the first change — true at T); else the flat column (caller's fallback, never changed). */
/**
 * THE value-true-at-time read, for any EmploymentEvent kind. Extracted from factorsAtWindowEnd so
 * pay and factor resolve through ONE implementation — the last four slices each found the same rule
 * written twice and eventually disagreeing with itself.
 *
 * BOUNDARY, unchanged and deliberately so: `effective_date < to` where `to` is the EXCLUSIVE window
 * end. That is the schema's stated `effective_date <= T` rule with T = the window's last instant, and
 * it was proven correct on a fixture (a factor dated the 1st applies IN that month, and flipping the
 * comparison to `<=` applied it a month early). Do not reinterpret it.
 *
 * Falls back to the FIRST later event's `previous_json` — the value that was in force before the
 * earliest recorded change. Returns no entry at all when there is no history; the caller decides
 * what an absent entry means, and must say so out loud rather than defaulting silently.
 */
/**
 * ── VALIDATORS ───────────────────────────────────────────────────────────────────────────────────
 * Supplied per kind by the caller. NEVER a cast: `value_json` is loosely-typed JSON, and coercing it
 * would turn a malformed event into a confident wrong answer. Each one is a type guard, and anything
 * failing it is REPORTED, not quietly skipped — see the note on `malformed` below.
 */
export const isFiniteNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
/** Allowance is legitimately nullable — "no entitlement recorded" is a value, not a fault. */
export const isNullableNumber = (v: unknown): v is number | null => v === null || isFiniteNumber(v);
export const isBooleanValue = (v: unknown): v is boolean => typeof v === 'boolean';
/** A weekday set: integers 0–6 (getUTCDay), no duplicates. An EMPTY array is valid and meaningful —
 *  it means "inherit the site's open days" (lib/rostered-days). */
export const isWeekdayArray = (v: unknown): v is number[] =>
  Array.isArray(v) && v.every((n) => Number.isInteger(n) && n >= 0 && n <= 6) && new Set(v as number[]).size === v.length;

export type ResolvedValues<T> = {
  values: Map<string, T>;
  /** Person ids whose newest applicable event carried a value the validator REFUSED. They are NOT
   *  silently dropped to the flat column and forgotten: the caller surfaces them, because the
   *  failure mode of this resolver is invisible — a discarded event leaves the person on today's
   *  column, which is exactly the bug being fixed, and looks like success. */
  malformed: string[];
};

/**
 * THE value-true-at-time read, for any EmploymentEvent kind and any value shape.
 *
 * BOUNDARY, unchanged: `effective_date < to` against an EXCLUSIVE window end — the schema's
 * `effective_date <= T` rule with T = the window's last instant, proven on a fixture. Do not
 * reinterpret it.
 *
 * Falls back to the FIRST later event's `previous_json` (the value in force before the earliest
 * recorded change). No entry at all when there is no history — the caller decides what absence
 * means and must say so out loud.
 */
export async function valuesAtWindowEnd<T>(
  ids: string[], to: Date, kind: string, field: string, validate: (v: unknown) => v is T,
): Promise<ResolvedValues<T>> {
  if (!ids.length) return { values: new Map<string, T>(), malformed: [] };
  const evs = (await prisma.employmentEvent.findMany({
    where: { cost_person_id: { in: ids }, kind: kind as any, voided_at: null },
    orderBy: [{ effective_date: 'asc' }, { created_at: 'asc' }],
    select: { cost_person_id: true, effective_date: true, value_json: true, previous_json: true },
  })) as any[];
  return resolveValuesAt(evs, to, field, validate);
}

/**
 * The resolution itself, over events ALREADY FETCHED — so a caller asking the same question for
 * twelve consecutive months pays for one query, not twelve. `valuesAtWindowEnd` is this function
 * plus the read; both must stay one rule, which is why the loop lives here and not in either.
 *
 * Events must arrive ordered by effective_date then created_at, as the query above orders them.
 */
export function resolveValuesAt<T>(
  evs: { cost_person_id: string; effective_date: Date; value_json: any; previous_json: any }[],
  to: Date, field: string, validate: (v: unknown) => v is T,
): ResolvedValues<T> {
  const values = new Map<string, T>();
  const malformed: string[] = [];
  const byPerson = new Map<string, any[]>();
  for (const e of evs) byPerson.set(e.cost_person_id, [...(byPerson.get(e.cost_person_id) ?? []), e]);
  for (const [pid, list] of byPerson) {
    const atOrBefore = list.filter((e) => e.effective_date.getTime() < to.getTime());
    const raw = atOrBefore.length
      ? atOrBefore[atOrBefore.length - 1].value_json?.[field]
      : list[0].previous_json?.[field];
    if (validate(raw)) values.set(pid, raw);
    else if (raw !== undefined) malformed.push(pid); // present but unusable — never a silent fallback
  }
  return { values, malformed };
}

// ---------- Utilisation = hours charged ÷ SELLABLE hours (month × site) ----------
// Numerator = the P&L's OWN charged-hours read (lib/charged-labour — extracted, not re-queried),
// called single-site. Denominator = getAvailableHours (factor-adjusted sellable). BOTH receive
// the SAME window object — numerator and denominator share identical boundaries by construction
// (the one-truth rail). 100% = performing exactly to expectation (the factor is baked into the
// denominator, so there is no separate target). Group aggregation is Σcharged ÷ Σsellable
// (never a mean of ratios) — callers sum the parts.
export type Utilisation = AvailableHours & {
  charged: number;          // decimal hours SOLD in the window (billable only — this site)
  rework: number;           // warranty-rework hours consumed (spent, not sold; NOT in the ratio)
  available: number;        // = hours (SELLABLE — aliased for the tile's charged ÷ sellable framing)
  ratio: number | null;     // charged/sellable; NULL when sellable === 0 (render "—", never NaN).
                            // NOT capped at 100% — beating expectation must show as >100%.
};

export async function getUtilisation(groupId: string, siteId: string, window: CapacityWindow): Promise<Utilisation> {
  const [invoices, avail] = await Promise.all([
    fetchLedgerInvoices({ groupId, siteIds: [siteId], from: window.from, to: window.to }),
    getAvailableHours(groupId, siteId, window),
  ]);
  const cl = chargedLabourCentihours(invoices);
  const charged = cl.centihours / 100;
  return {
    ...avail,
    charged,
    rework: cl.reworkCentihours / 100,
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
  charged: number; rework: number; available: number; rawHours: number; ratio: number | null; // available = SELLABLE
  configComplete: boolean; missingHoursMechanics: string[];
  unknownStartPeople: string[]; // counted DESPITE an unknown start date — surfaced, never silent
  malformedEvents: string[];    // dated event present but its value was REFUSED by the validator
  mechanicCount: number; countedPeople: string[]; rosteredDays: number; leaveHours: number; phHours: number;
  grossHours: number; leaveByType: Record<string, number>; // waterfall grain (see AvailableHours)
  leaveDaysByType: Record<string, number>; nonRosteredDays: number; // day-unit grain (manpower row)
  factorParts: Array<{ name: string; rawHours: number; factorPct: number; sellableHours: number }>;
  perSite: Array<{ siteId: string; siteName: string; charged: number; rework: number; available: number; rawHours: number; ratio: number | null; rosteredDays: number; leaveHours: number; phHours: number; mechanicCount: number }>;
};

export async function getGroupUtilisation(groupId: string, siteIds: string[], window: CapacityWindow): Promise<GroupUtilisation> {
  // NO SEPARATE CENSUS. This used to run its own costPerson query and re-derive who counts from the
  // FLAT columns — a fourth copy of the rule, and one that disagreed with the parts the moment any
  // attribute became effective-dated (it counted non-chargeable people, and read today's hours for a
  // historic month). The parts already resolved every attribute as of the window; the roll-up's only
  // job is to make them DISTINCT across sites, which is what the census was for.
  const [sites, parts] = await Promise.all([
    prisma.site.findMany({ where: { id: { in: siteIds }, group_id: groupId }, orderBy: { created_at: 'asc' }, select: { id: true, site_name: true } }) as any,
    Promise.all(siteIds.map((sid) => getUtilisation(groupId, sid, window))),
  ]);
  const distinct = (k: 'missingHoursMechanics' | 'unknownStartPeople' | 'countedPeople' | 'malformedEvents') =>
    [...new Set(parts.flatMap((u: any) => (u[k] ?? []) as string[]))];
  const nameOf = new Map<string, string>(sites.map((s: any) => [s.id, s.site_name]));
  let charged = 0, rework = 0, available = 0, rawHours = 0, rosteredDays = 0, leaveHours = 0, phHours = 0, grossHours = 0;
  let nonRosteredDays = 0;
  const leaveByType: Record<string, number> = {};
  const leaveDaysByType: Record<string, number> = {};
  const factorParts: Array<{ name: string; rawHours: number; factorPct: number; sellableHours: number }> = [];
  const perSite = siteIds.map((sid, i) => {
    const u = parts[i];
    charged += u.charged; rework += u.rework; available += u.available; rawHours += u.rawHours;
    rosteredDays += u.rosteredDays; leaveHours += u.leaveHours; phHours += u.phHours;
    grossHours += u.grossHours;
    factorParts.push(...u.factorParts);
    for (const [ty, h] of Object.entries(u.leaveByType)) leaveByType[ty] = Math.round(((leaveByType[ty] ?? 0) + h) * 100) / 100;
    for (const [ty, d] of Object.entries(u.leaveDaysByType)) leaveDaysByType[ty] = Math.round(((leaveDaysByType[ty] ?? 0) + d) * 1000) / 1000;
    nonRosteredDays += u.nonRosteredDays;
    return { siteId: sid, siteName: nameOf.get(sid) ?? '—', charged: u.charged, rework: u.rework, available: u.available, rawHours: u.rawHours, ratio: u.ratio, rosteredDays: u.rosteredDays, leaveHours: u.leaveHours, phHours: u.phHours, mechanicCount: u.mechanicCount };
  });
  charged = Math.round(charged * 100) / 100; rework = Math.round(rework * 100) / 100; available = Math.round(available * 100) / 100; rawHours = Math.round(rawHours * 100) / 100;
  const missingHoursMechanics = distinct('missingHoursMechanics');
  return {
    charged, rework, available, rawHours,
    ratio: available === 0 ? null : charged / available, // null → "—", never NaN/Infinity; NOT capped
    configComplete: missingHoursMechanics.length === 0,
    missingHoursMechanics,
    // Counted, but say so. An unknown start is a data gap the garage can close, not a fact.
    unknownStartPeople: distinct('unknownStartPeople'),
    malformedEvents: distinct('malformedEvents'),
    mechanicCount: distinct('countedPeople').length,
    countedPeople: distinct('countedPeople'),
    rosteredDays, leaveHours: Math.round(leaveHours * 100) / 100, phHours: Math.round(phHours * 100) / 100,
    grossHours: Math.round(grossHours * 100) / 100, leaveByType,
    leaveDaysByType, nonRosteredDays: Math.round(nonRosteredDays * 1000) / 1000,
    factorParts,
    perSite,
  };
}
