/**
 * File: lib/manpower.ts
 * THE manpower row — eight figures about people, for one month.
 *
 * ── THE RULE THIS FILE OBEYS ────────────────────────────────────────────────────────────────────
 * Every figure here either IS a number the capacity or P&L calculation already consumes, or is
 * labelled as context. Nothing is computed a second way. `employedDuring` decides who; the day
 * counts come out of getAvailableHours' own loop (leaveDaysByType / nonRosteredDays); gross pay IS
 * monthlyWageBill. Where a tile is NOT an input — headcount, new hires, exits — `reconciles` is
 * false and the screen says so, because a prominent number that looks like an input and isn't is
 * how a garage owner ends up explaining a figure that nothing depends on.
 *
 * ── WHAT RECONCILES, EXACTLY ────────────────────────────────────────────────────────────────────
 *   grossPayPennies   ≡ monthlyWageBill().pennies  → the P&L cost base's wage half
 *   countedInCapacity ≡ getGroupUtilisation().mechanicCount
 *   holidayDays/sickDays ≡ the same consumed days that produced leaveByType's hours
 *   nonRosteredDays   ≡ the pattern gap capacity withheld by never rostering those days
 *   pilonPennies      ⊂ grossPayPennies (a component, never an independent figure)
 * and what does NOT:
 *   headcountEmployed  — capacity counts the chargeable, configured, allocated SUBSET
 *   newHires / exits   — capacity is whole-month and unprorated, so a hire on the 28th contributes
 *                        a full month. The count is a fact about the month, not an input to it.
 *
 * ── HONEST-NULL ─────────────────────────────────────────────────────────────────────────────────
 * `known: false` means the month falls entirely before this tenant has any employment data — the
 * answer is unknown, not zero, and the row renders em-dashes. Known-zero renders 0. The anchor is
 * the earliest thing that could make a month answerable: the tenant's creation or the earliest
 * recorded start date, whichever is earlier.
 */
import { prisma } from '@/lib/db';
import { employedDuring, getGroupUtilisation, type CapacityWindow } from '@/lib/capacity';
import { monthlyWageBill } from '@/lib/dashboard-tiles';

export type ManpowerFigure = {
  /** null = unknown (outside the tenant's data). A known zero is 0, never null. */
  value: number | null;
  /** true = this exact number is consumed by the capacity or P&L calculation. */
  reconciles: boolean;
  /** Names behind the number, where naming them is useful (hires, exits, PILON). */
  names?: string[];
};

export type Manpower = {
  known: boolean;
  headcountEmployed: ManpowerFigure;   // anyone employed during the month (work basis)
  countedInCapacity: ManpowerFigure;   // the subset capacity actually counts
  grossPayPennies: ManpowerFigure;     // GROSS PAY — not employment cost (no NI/pension/levy)
  holidayDays: ManpowerFigure;
  sickDays: ManpowerFigure;
  nonRosteredDays: ManpowerFigure;     // day release AND part-time patterns, not distinguished
  newHires: ManpowerFigure;
  exits: ManpowerFigure;
  pilonDays: ManpowerFigure;
  pilonPennies: ManpowerFigure;
  /** Salaried people costed at their CURRENT pay because no wage history exists. */
  assumedPayPeople: string[];
  /** Hourly people contributing capacity but NOTHING to the wage bill — see monthlyWageBill. */
  hourlyExcludedPeople: string[];
};

const known = (v: number, reconciles: boolean, names?: string[]): ManpowerFigure => ({ value: v, reconciles, names });
const unknown = (reconciles: boolean): ManpowerFigure => ({ value: null, reconciles });

/** Days in [a, b] inclusive, or 0 when b precedes a. Calendar days — PILON is paid per day, not per shift. */
const inclusiveDays = (a: Date, b: Date) =>
  b.getTime() < a.getTime() ? 0 : Math.round((b.getTime() - a.getTime()) / 86_400_000) + 1;

export async function getManpower(groupId: string, siteIds: string[], window: CapacityWindow): Promise<Manpower> {
  // THE ANCHOR. Before this, the tenant has nothing to say about a month — and saying "0 exits"
  // about a month before the garage was on the system is a lie dressed as data.
  const [group, earliest] = await Promise.all([
    prisma.group.findUnique({ where: { id: groupId }, select: { created_at: true } }),
    prisma.costPerson.findFirst({ where: { group_id: groupId, start_date: { not: null } }, orderBy: { start_date: 'asc' }, select: { start_date: true } }),
  ]);
  const anchorTimes = [group?.created_at?.getTime(), earliest?.start_date?.getTime()].filter((t): t is number => typeof t === 'number');
  const anchor = anchorTimes.length ? Math.min(...anchorTimes) : null;
  const isKnown = anchor != null && window.to.getTime() > anchor;

  if (!isKnown) {
    return {
      known: false,
      headcountEmployed: unknown(false), countedInCapacity: unknown(true), grossPayPennies: unknown(true),
      holidayDays: unknown(true), sickDays: unknown(true), nonRosteredDays: unknown(true),
      newHires: unknown(false), exits: unknown(false), pilonDays: unknown(true), pilonPennies: unknown(true),
      assumedPayPeople: [], hourlyExcludedPeople: [],
    };
  }

  // WHO — the same clause capacity uses, on the WORK basis (employed = turned up, or was on the
  // books to). Allocation-scoped to the visible sites so a multi-site group's row matches its tiles.
  const employedWork = (await prisma.costPerson.findMany({
    where: { ...employedDuring(groupId, window, 'work'), allocations: { some: { site_id: { in: siteIds } } } },
    select: { id: true, name: true, start_date: true, work_end_date: true, pay_end_date: true },
  })) as any[];

  const [u, wage] = await Promise.all([
    getGroupUtilisation(groupId, siteIds, window),
    monthlyWageBill(groupId, siteIds, window),
  ]);

  // HIRES AND EXITS — dates falling INSIDE the month. Context, not inputs: capacity is whole-month
  // and unprorated, so a hire on the 28th already contributes a full month's sellable hours.
  const inWindow = (d: Date | null) => d != null && d.getTime() >= window.from.getTime() && d.getTime() < window.to.getTime();
  const hires = employedWork.filter((p) => inWindow(p.start_date)).map((p) => p.name as string);
  const exits = employedWork.filter((p) => inWindow(p.work_end_date)).map((p) => p.name as string);

  // PILON — days paid for no output, and their cost. Anyone whose PAID window extends past their
  // WORKING one, intersected with this month. This is the number the two-date model exists for,
  // and it is a COMPONENT of gross pay above, never a separate cost.
  const pilonPeople = (await prisma.costPerson.findMany({
    where: {
      ...employedDuring(groupId, window, 'pay'),
      cost_type: 'salary',
      work_end_date: { not: null },
      allocations: { some: { site_id: { in: siteIds } } },
    },
    select: { id: true, name: true, amount_pennies: true, work_end_date: true, pay_end_date: true,
      allocations: { where: { site_id: { in: siteIds } }, select: { percent: true } } },
  })) as any[];

  const monthDays = Math.round((window.to.getTime() - window.from.getTime()) / 86_400_000);
  let pilonDays = 0, pilonPennies = 0;
  const pilonNames: string[] = [];
  for (const p of pilonPeople) {
    const payEnd: Date | null = p.pay_end_date ?? p.work_end_date;
    if (!payEnd || !p.work_end_date) continue;
    // The paid-but-not-working stretch is the day AFTER the last working day, to the last paid day.
    const firstPilon = new Date(p.work_end_date.getTime() + 86_400_000);
    const from = new Date(Math.max(firstPilon.getTime(), window.from.getTime()));
    const to = new Date(Math.min(payEnd.getTime(), window.to.getTime() - 86_400_000));
    const days = inclusiveDays(from, to);
    if (days <= 0) continue;
    pilonDays += days;
    pilonNames.push(p.name);
    // Their share of THIS month's gross pay, by day — so the figure is a slice of the wage tile
    // rather than a parallel calculation with its own rounding.
    const alloc = p.allocations.reduce((s: number, a: any) => s + Number(a.percent), 0) / 100;
    pilonPennies += Math.round((Number(p.amount_pennies) / 12) * (days / monthDays) * alloc);
  }

  const d = (n: number) => Math.round(n * 100) / 100;
  return {
    known: true,
    // CONTEXT: everyone employed. Deliberately NOT the capacity population — the gap between this
    // and countedInCapacity is itself the informative part (managers, non-chargeable staff,
    // chargeable people with no hours set).
    headcountEmployed: known(employedWork.length, false),
    countedInCapacity: known(u.mechanicCount, true, u.countedPeople),
    grossPayPennies: known(wage.pennies, true),
    holidayDays: known(d(u.leaveDaysByType.annual ?? 0), true),
    sickDays: known(d(u.leaveDaysByType.sick ?? 0), true),
    nonRosteredDays: known(d(u.nonRosteredDays), true),
    newHires: known(hires.length, false, hires),
    exits: known(exits.length, false, exits),
    pilonDays: known(pilonDays, true, pilonNames),
    pilonPennies: known(pilonPennies, true, pilonNames),
    assumedPayPeople: wage.assumedPayPeople,
    hourlyExcludedPeople: wage.hourlyExcludedPeople,
  };
}
