/**
 * File: lib/booking-slots.ts
 * PURE helpers for the Quote-tab booking form: the start time-slots (bounded by site hours), the
 * duration dropdown (sub-day steps by the site's granularity, then rolling into whole days), and the
 * DERIVED end. No I/O. The diary is unaffected — it still reads start_at/end_at, which now just
 * reflect start + duration. Times are naive-UTC wall times (same convention as the diary/booking),
 * so day arithmetic in UTC has no DST drift: "Mon 09:00 + 2 days" = "Wed 09:00".
 */
const pad2 = (n: number) => String(n).padStart(2, '0');

/** Start time-slots "HH:MM" from open_hour up to (not including) close_hour, stepping by stepMin (15). */
export function startTimeSlots(openHour: number, closeHour: number, stepMin = 15): string[] {
  const out: string[] = [];
  for (let m = openHour * 60; m < closeHour * 60; m += stepMin) out.push(`${pad2(Math.floor(m / 60))}:${pad2(m % 60)}`);
  return out;
}

export type DurationOption = { value: string; kind: 'min' | 'day'; amount: number };

/** Sub-day options stepping by stepMin up to the working-day length, then 1..maxDays whole days. */
export function durationOptions(openHour: number, closeHour: number, stepMin = 30, maxDays = 5): DurationOption[] {
  const step = Math.max(5, stepMin);
  const workMin = Math.max(step, (closeHour - openHour) * 60);
  const opts: DurationOption[] = [];
  for (let m = step; m <= workMin; m += step) opts.push({ value: `m:${m}`, kind: 'min', amount: m });
  for (let d = 1; d <= maxDays; d++) opts.push({ value: `d:${d}`, kind: 'day', amount: d });
  return opts;
}

/** Derived end ISO from a start ISO + a duration option value ("m:90" or "d:2"). */
export function computeEndISO(startISO: string, value: string): string {
  const [kind, nStr] = value.split(':');
  const n = Number(nStr);
  const start = Date.parse(startISO);
  const end = kind === 'd' ? start + n * 24 * 60 * 60 * 1000 : start + n * 60 * 1000;
  return new Date(end).toISOString();
}

/** Best-matching duration option for an existing booking (reschedule seed): exact whole-days else snapped minutes. */
export function seedDurationValue(startISO: string, endISO: string, openHour: number, closeHour: number, stepMin = 30, maxDays = 5): string {
  const step = Math.max(5, stepMin);
  const mins = Math.round((Date.parse(endISO) - Date.parse(startISO)) / 60000);
  if (mins > 0 && mins % (24 * 60) === 0) {
    const d = mins / (24 * 60);
    if (d >= 1 && d <= maxDays) return `d:${d}`;
  }
  const workMin = Math.max(step, (closeHour - openHour) * 60);
  if (mins > 0) {
    const snapped = Math.min(workMin, Math.max(step, Math.round(mins / step) * step));
    return `m:${snapped}`;
  }
  return `m:${step}`;
}
