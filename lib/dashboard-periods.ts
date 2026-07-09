/**
 * File: lib/dashboard-periods.ts
 * THE period engine for the dashboard (Xero-style picker). Pure: preset + FY-start-month + `now`
 * → a UTC [from, to] range. Financial-year presets respect the tenant's fy_start_month; relative
 * presets compute live. Shared by the API (server truth) and the picker UI (labels only).
 */
export const PERIOD_PRESETS = [
  'this_month', 'this_quarter', 'this_fy',
  'last_month', 'last_quarter', 'last_fy',
  'mtd', 'qtd', 'ytd',
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
