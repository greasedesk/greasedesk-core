/**
 * File: lib/occupancy.ts
 * THE shared occupancy-footprint chokepoint. Given a booking's WORKING duration (minutes) and the
 * site's opening hours + open-days, it returns the real per-day, working-hours-bounded segments the
 * job occupies — same-day through multi-week — plus the true wrapped end. Duration is working time:
 * a job fills only within [open, close); on reaching close it resumes at the NEXT OPEN day's opening,
 * skipping whatever days are actually closed (reads the stored open_days — never hardcodes a weekend).
 *
 * All three consumers (booking-form end preview, diary render, clash guard) read THIS so they can't
 * drift. Times are naive-UTC wall times (same convention as the diary), so day arithmetic in UTC has
 * no DST drift. Pure — no I/O.
 */
export type Segment = { startISO: string; endISO: string };
export type Footprint = { segments: Segment[]; endISO: string };

const MIN = 60000;
const todMin = (ms: number) => { const d = new Date(ms); return d.getUTCHours() * 60 + d.getUTCMinutes(); };
const dow = (ms: number) => new Date(ms).getUTCDay(); // 0=Sun..6=Sat
const atOpen = (ms: number, openMin: number) => {
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 0, 0, 0, 0) + openMin * MIN;
};

/** Advance to the earliest working moment >= ms: within [open, close) on a day in openDays. */
function advanceToOpen(ms: number, openMin: number, closeMin: number, openDays: number[]): number {
  let cur = ms;
  for (let guard = 0; guard < 3700; guard++) { // ~10yr of days; bounded so a bad openDays can't loop forever
    if (openDays.includes(dow(cur))) {
      const t = todMin(cur);
      if (t < openMin) return atOpen(cur, openMin);
      if (t < closeMin) return cur;
    }
    cur = atOpen(cur + 24 * 3600000, openMin); // next calendar day at opening, re-check
  }
  throw new Error('OCCUPANCY_NO_OPEN_DAY');
}

export function computeFootprint(
  startISO: string,
  workingMinutes: number,
  openHour: number,
  closeHour: number,
  openDays: number[],
): Footprint {
  const openMin = openHour * 60;
  const closeMin = closeHour * 60;
  if (!openDays || openDays.length === 0 || !(workingMinutes > 0)) {
    return { segments: [], endISO: startISO };
  }
  const segments: Segment[] = [];
  let remaining = Math.round(workingMinutes);
  let cur = advanceToOpen(Date.parse(startISO), openMin, closeMin, openDays);
  let lastEnd = cur;
  while (remaining > 0) {
    cur = advanceToOpen(cur, openMin, closeMin, openDays);
    const avail = closeMin - todMin(cur);
    const take = Math.min(remaining, avail);
    const segEnd = cur + take * MIN;
    segments.push({ startISO: new Date(cur).toISOString(), endISO: new Date(segEnd).toISOString() });
    remaining -= take;
    lastEnd = segEnd;
    cur = segEnd; // if this hit close, the next advanceToOpen rolls to the next open day
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
