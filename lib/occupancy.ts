/**
 * File: lib/occupancy.ts
 * THE shared occupancy-footprint chokepoint. Given a booking's WORKING duration (minutes), the site's
 * opening hours, open-days, and BREAKS (non-working bands like lunch), it returns the real per-day,
 * working-hours-bounded segments the job occupies — plus the true wrapped end. Working time each day
 * is [open, close) minus the break bands; work fills those sub-bands in order, pausing at each break
 * and at close, resuming at the next working moment (break end, or next open day's opening). A job
 * spanning a break produces two segments that day (morning + afternoon).
 *
 * BREAKS are the same shape as the close-of-day wrap — a boundary to pause at and resume after — so
 * nothing new conceptually. breaks defaults to [] → identical to the pre-breaks behaviour, so callers
 * that don't pass breaks (or sites with none) are unchanged. Times are naive-UTC wall times (no DST).
 * All three consumers (form end-preview, diary render, clash guard) read THIS so they can't drift.
 */
export type Segment = { startISO: string; endISO: string };
export type Break = { start: number; end: number }; // minutes-from-midnight, [start, end)
export type Footprint = { segments: Segment[]; endISO: string };

const MIN = 60000;
const todMin = (ms: number) => { const d = new Date(ms); return d.getUTCHours() * 60 + d.getUTCMinutes(); };
const dow = (ms: number) => new Date(ms).getUTCDay(); // 0=Sun..6=Sat
const midnight = (ms: number) => { const d = new Date(ms); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 0, 0, 0, 0); };
const atMin = (ms: number, min: number) => midnight(ms) + min * MIN;

/** Coerce a Site.breaks JSON value into a validated Break[] (drops anything malformed). */
export function parseBreaks(v: unknown): Break[] {
  if (!Array.isArray(v)) return [];
  return v
    .filter((b): b is Break => !!b && typeof (b as any).start === 'number' && typeof (b as any).end === 'number' && (b as any).end > (b as any).start)
    .map((b) => ({ start: b.start, end: b.end }));
}

/** The working sub-bands of a day: [open, close) minus the (clamped, merged) break bands. */
export function dayBands(openMin: number, closeMin: number, breaks: Break[]): Array<[number, number]> {
  const bs = (breaks || []).filter((b) => b.end > b.start).sort((a, b) => a.start - b.start);
  const out: Array<[number, number]> = [];
  let cur = openMin;
  for (const b of bs) {
    const bStart = Math.max(openMin, Math.min(b.start, closeMin));
    const bEnd = Math.max(openMin, Math.min(b.end, closeMin));
    if (bStart > cur) out.push([cur, bStart]);
    cur = Math.max(cur, bEnd);
  }
  if (cur < closeMin) out.push([cur, closeMin]);
  return out.filter(([s, e]) => e > s);
}

/** Advance to the earliest WORKING moment >= ms: inside a working sub-band on a day in openDays. */
function advanceToWorking(ms: number, bands: Array<[number, number]>, openMin: number, openDays: number[]): number {
  let cur = ms;
  for (let guard = 0; guard < 3700; guard++) {
    if (openDays.includes(dow(cur))) {
      const t = todMin(cur);
      for (const [bStart, bEnd] of bands) if (t < bEnd) return atMin(cur, Math.max(t, bStart));
    }
    cur = atMin(cur + 24 * 3600000, openMin); // next calendar day at opening, re-check
  }
  throw new Error('OCCUPANCY_NO_WORKING_TIME');
}

export function computeFootprint(
  startISO: string,
  workingMinutes: number,
  openHour: number,
  closeHour: number,
  openDays: number[],
  breaks: Break[] = [],
): Footprint {
  const openMin = openHour * 60;
  const closeMin = closeHour * 60;
  if (!openDays || openDays.length === 0 || !(workingMinutes > 0)) return { segments: [], endISO: startISO };
  const bands = dayBands(openMin, closeMin, breaks);
  if (bands.length === 0) return { segments: [], endISO: startISO };

  const segments: Segment[] = [];
  let remaining = Math.round(workingMinutes);
  let cur = advanceToWorking(Date.parse(startISO), bands, openMin, openDays);
  let lastEnd = cur;
  while (remaining > 0) {
    cur = advanceToWorking(cur, bands, openMin, openDays);
    const t = todMin(cur);
    const band = bands.find(([bStart, bEnd]) => t >= bStart && t < bEnd);
    const bandEnd = band ? band[1] : closeMin; // pause at the next boundary: break-start OR close
    const take = Math.min(remaining, bandEnd - t);
    const segEnd = atMin(cur, t + take);
    segments.push({ startISO: new Date(cur).toISOString(), endISO: new Date(segEnd).toISOString() });
    remaining -= take;
    lastEnd = segEnd;
    cur = segEnd; // hitting a break-start or close → next advanceToWorking rolls to the next band/day
  }
  return { segments, endISO: new Date(lastEnd).toISOString() };
}

/** Half-open overlap between two segments. */
export function segmentsOverlap(a: Segment, b: Segment): boolean {
  return Date.parse(a.startISO) < Date.parse(b.endISO) && Date.parse(a.endISO) > Date.parse(b.startISO);
}

/** Do any segments of two footprints overlap? (the clash test) */
export function footprintsClash(a: Footprint, b: Footprint): boolean {
  for (const sa of a.segments) for (const sb of b.segments) if (segmentsOverlap(sa, sb)) return true;
  return false;
}
