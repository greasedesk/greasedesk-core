/**
 * File: lib/dashboard-periods.ts
 * THE period engine for the dashboard (Xero-style picker). Pure: preset + FY-start-month + `now`
 * → a UTC [from, to] range. Financial-year presets respect the tenant's fy_start_month; relative
 * presets compute live. Shared by the API (server truth) and the picker UI (labels only).
 */
// Order = the dropdown order: common whole-month picks first (the P&L follows those exactly),
// then to-dates, then quarters/FYs. Membership checks are order-independent.
export const PERIOD_PRESETS = [
  'this_month', 'last_month', 'mtd',
  'this_quarter', 'last_quarter', 'qtd',
  'this_fy', 'last_fy', 'ytd',
] as const;
export type PeriodPreset = typeof PERIOD_PRESETS[number];

const monthStart = (y: number, m0: number) => new Date(Date.UTC(y, m0, 1));

/** [from, to): to is EXCLUSIVE (first instant after the period) — avoids end-of-day maths. */
export function presetRange(preset: PeriodPreset, fyStartMonth: number, now: Date = new Date()): { from: Date; to: Date } {
  const y = now.getUTCFullYear();
  const m0 = now.getUTCMonth(); // 0-based
  const fy0 = Math.min(12, Math.max(1, Math.trunc(fyStartMonth) || 1)) - 1;
  const q0 = Math.floor(m0 / 3) * 3; // calendar quarter start month (0-based)
  const fyStartYear = m0 >= fy0 ? y : y - 1;
  switch (preset) {
    case 'this_month': return { from: monthStart(y, m0), to: monthStart(y, m0 + 1) };
    case 'last_month': return { from: monthStart(y, m0 - 1), to: monthStart(y, m0) };
    case 'this_quarter': return { from: monthStart(y, q0), to: monthStart(y, q0 + 3) };
    case 'last_quarter': return { from: monthStart(y, q0 - 3), to: monthStart(y, q0) };
    case 'this_fy': return { from: monthStart(fyStartYear, fy0), to: monthStart(fyStartYear + 1, fy0) };
    case 'last_fy': return { from: monthStart(fyStartYear - 1, fy0), to: monthStart(fyStartYear, fy0) };
    case 'mtd': return { from: monthStart(y, m0), to: now };
    case 'qtd': return { from: monthStart(y, q0), to: now };
    case 'ytd': return { from: monthStart(y, 0), to: now };
  }
}

/** Parse ?from=yyyy-mm-dd&to=yyyy-mm-dd (to inclusive as a day → exclusive instant) or a preset. */
export function resolveRange(q: { preset?: string; from?: string; to?: string }, fyStartMonth: number, now: Date = new Date()): { from: Date; to: Date } | null {
  if (q.preset && (PERIOD_PRESETS as readonly string[]).includes(q.preset)) {
    return presetRange(q.preset as PeriodPreset, fyStartMonth, now);
  }
  const day = /^\d{4}-\d{2}-\d{2}$/;
  if (q.from && q.to && day.test(q.from) && day.test(q.to)) {
    const from = new Date(`${q.from}T00:00:00.000Z`);
    const toDay = new Date(`${q.to}T00:00:00.000Z`);
    if (Number.isNaN(from.getTime()) || Number.isNaN(toDay.getTime()) || toDay < from) return null;
    return { from, to: new Date(toDay.getTime() + 86_400_000) };
  }
  return null;
}

// ---------- Month-grained spans (the P&L strip) ----------
// Profit tiles are calendar-month-grained BY DESIGN: the wage bill is a monthly lump, so a
// partial-month profit figure would be fiction. Only whole-month spans exist here.
export const MONTH_PRESETS = ['this_month', 'last_month', 'this_quarter', 'last_quarter', 'this_fy', 'last_fy'] as const;
export type MonthPreset = typeof MONTH_PRESETS[number];

export type MonthSpan = { from: Date; to: Date; months: number };

const monthsBetween = (from: Date, to: Date) =>
  (to.getUTCFullYear() - from.getUTCFullYear()) * 12 + (to.getUTCMonth() - from.getUTCMonth());

export function monthPresetSpan(preset: MonthPreset, fyStartMonth: number, now: Date = new Date()): MonthSpan {
  // Reuses presetRange — these four presets are already whole-month ranges.
  const r = presetRange(preset, fyStartMonth, now);
  return { ...r, months: monthsBetween(r.from, r.to) };
}

/** Parse ?mfrom=yyyy-mm&mto=yyyy-mm (inclusive months) or a month preset. */
export function resolveMonthSpan(q: { mpreset?: string; mfrom?: string; mto?: string }, fyStartMonth: number, now: Date = new Date()): MonthSpan | null {
  if (q.mpreset && (MONTH_PRESETS as readonly string[]).includes(q.mpreset)) {
    return monthPresetSpan(q.mpreset as MonthPreset, fyStartMonth, now);
  }
  const m = /^(\d{4})-(\d{2})$/;
  const a = q.mfrom?.match(m); const b = q.mto?.match(m);
  if (a && b) {
    const from = new Date(Date.UTC(Number(a[1]), Number(a[2]) - 1, 1));
    const to = new Date(Date.UTC(Number(b[1]), Number(b[2]), 1)); // exclusive: first day after the last month
    if (to <= from) return null;
    return { from, to, months: monthsBetween(from, to) };
  }
  return null;
}

// ---- ONE period control drives both strips ----
// The P&L is whole-calendar-months ONLY (fixed monthly wages don't honestly decompose into
// part-periods — never pro-rate to make a picker option "work"). This maps the single (cash)
// selection to the P&L's month window:
//  - whole-month windows (this/last month, this/last quarter, this/last FY, and a custom range
//    that is exactly whole months) → the P&L FOLLOWS EXACTLY (degraded: false);
//  - part-periods (mtd/qtd/ytd → the current month; a partial custom range → the month containing
//    its END date) → the P&L shows that CONTAINING CALENDAR MONTH and the UI says so plainly
//    (degraded: true) — never a silently different period.
export type MonthSelection = { mpreset?: MonthPreset; mfrom?: string; mto?: string; degraded: boolean };
export function monthParamsForSelection(
  preset: PeriodPreset | 'custom', customFrom: string, customTo: string,
): MonthSelection | null {
  if (preset !== 'custom') {
    if ((MONTH_PRESETS as readonly string[]).includes(preset)) return { mpreset: preset as MonthPreset, degraded: false };
    return { mpreset: 'this_month', degraded: true }; // mtd/qtd/ytd → containing calendar month = the current one
  }
  const day = /^(\d{4})-(\d{2})-(\d{2})$/;
  const a = customFrom.match(day); const b = customTo.match(day);
  if (!a || !b) return null; // incomplete custom range — wait for both ends
  const from = new Date(`${customFrom}T00:00:00.000Z`);
  const toInc = new Date(`${customTo}T00:00:00.000Z`);
  if (Number.isNaN(from.getTime()) || Number.isNaN(toInc.getTime()) || toInc < from) return null;
  const lastDayOfMonth = new Date(Date.UTC(toInc.getUTCFullYear(), toInc.getUTCMonth() + 1, 0)).getUTCDate();
  const wholeMonths = from.getUTCDate() === 1 && toInc.getUTCDate() === lastDayOfMonth;
  if (wholeMonths) return { mfrom: customFrom.slice(0, 7), mto: customTo.slice(0, 7), degraded: false };
  const m = customTo.slice(0, 7);
  return { mfrom: m, mto: m, degraded: true }; // containing month of the range END
}

// ---------- LABELS (pure) ----------
// Shared by every screen that offers the picker. They live beside presetRange because they describe
// the SAME windows — a label that drifts from the range it names is the bug this file exists to
// prevent.

export const monthNameOf = (y: number, m0: number, locale: string, style: 'long' | 'short' = 'long') =>
  new Date(Date.UTC(y, m0, 1)).toLocaleDateString(locale, { month: style, year: 'numeric', timeZone: 'UTC' });

/** month−2 … month−11 as named-month options; `this_month`/`last_month` are separate presets. */
export function rollingMonths(now: Date, locale: string): Array<{ value: string; label: string }> {
  const out: Array<{ value: string; label: string }> = [];
  for (let i = 2; i <= 11; i++) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
    out.push({ value: `m:${key}`, label: monthNameOf(d.getUTCFullYear(), d.getUTCMonth(), locale) });
  }
  return out;
}

/** The month group split by calendar year — twelve in one flat list is a wall, and grouping never
 *  drops an option the way truncating would. */
export function monthGroups(
  now: Date, locale: string, label: { thisMonth: (m: string) => string; lastMonth: (m: string) => string },
): Array<{ year: number; options: Array<{ value: string; label: string }> }> {
  const head = [
    { value: 'this_month', label: label.thisMonth(monthNameOf(now.getUTCFullYear(), now.getUTCMonth(), locale)), offset: 0 },
    { value: 'last_month', label: label.lastMonth(monthNameOf(now.getUTCFullYear(), now.getUTCMonth() - 1, locale)), offset: 1 },
  ];
  const rest = rollingMonths(now, locale).map((m, i) => ({ ...m, offset: i + 2 }));
  const groups = new Map<number, Array<{ value: string; label: string }>>();
  for (const e of [...head, ...rest]) {
    const y = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - e.offset, 1)).getUTCFullYear();
    if (!groups.has(y)) groups.set(y, []);
    groups.get(y)!.push({ value: e.value, label: e.label });
  }
  return [...groups.entries()].map(([year, options]) => ({ year, options }));
}

/** FY range label from Group.fy_start_month, e.g. "Apr 2026 – Mar 2027". offset 0 = this FY. */
export function fyRangeLabel(now: Date, fyStartMonth: number, offset: number, locale: string): string {
  const fy0 = Math.min(12, Math.max(1, Math.trunc(fyStartMonth) || 1)) - 1;
  const m0 = now.getUTCMonth(), y = now.getUTCFullYear();
  const startYear = (m0 >= fy0 ? y : y - 1) + offset;
  const from = new Date(Date.UTC(startYear, fy0, 1));
  const toIncl = new Date(Date.UTC(startYear + 1, fy0, 0));
  return `${monthNameOf(from.getUTCFullYear(), from.getUTCMonth(), locale, 'short')} – ${monthNameOf(toIncl.getUTCFullYear(), toIncl.getUTCMonth(), locale, 'short')}`;
}

/** A named month `m:YYYY-MM` → the cash-range querystring. The ONE place that expansion happens. */
export function namedMonthRangeQS(preset: string): string | null {
  if (!preset.startsWith('m:')) return null;
  const key = preset.slice(2);
  const [y, mo] = key.split('-').map(Number);
  if (!y || !mo) return null;
  const last = new Date(Date.UTC(y, mo, 0)).getUTCDate();
  return `from=${key}-01&to=${key}-${String(last).padStart(2, '0')}`;
}
