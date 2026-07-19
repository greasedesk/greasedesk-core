/**
 * File: lib/site-config.ts
 * THE value-true-at-time read for Site configuration — the EmploymentEvent pattern applied to the
 * site, and the SECOND such reader in the system (lib/capacity.factorsAtWindowEnd was the first).
 *
 * WHY THIS EXISTS: Site.open_days is a single CURRENT value, so every historical window was
 * computed against today's trading pattern. Great Bridge traded Mon–Sat until 2026-04-01 and
 * Mon–Fri after; without this, a March report silently used the five-day pattern and understated
 * March's capacity for anyone inheriting the site's days.
 *
 * RESOLUTION (identical rule to factorsAtWindowEnd — deliberately, so there is one mental model):
 *   1. latest non-voided event with effective_date < T  → its value_json
 *   2. else, if a LATER event exists                    → the EARLIEST later event's previous_json
 *      (the value that applied BEFORE the first recorded change — true at T)
 *   3. else                                             → the caller's fallback (the flat column)
 *
 * Rule 2 is what makes ONE event represent BOTH eras: the 2026-04-01 row carries the five-day
 * pattern forward and the six-day pattern backward. No origin event needs backfilling.
 *
 * WINDOW END, not window start: a window is resolved as of its END, matching the factor read, so a
 * change taking effect mid-window applies to the whole window rather than splitting it. That is a
 * deliberate simplification — mid-month changes are rare and splitting would need a day-by-day
 * resolve. If that ever matters, change it HERE and both readers move together.
 */
import { prisma } from '@/lib/db';

/** Coerce a stored JSON value into a weekday array, or null when it isn't one. */
function toDays(v: unknown): number[] | null {
  if (!Array.isArray(v)) return null;
  const out = v.map(Number).filter((n) => Number.isInteger(n) && n >= 0 && n <= 6);
  return out.length ? out : null;
}

/**
 * Trading days for ONE site as of `to`. `fallback` is the flat Site.open_days column — passed in
 * by the caller so this stays a single query and the flat column keeps its role as current truth.
 */
export async function openDaysAtWindowEnd(
  siteId: string,
  to: Date,
  fallback: number[] | null | undefined,
): Promise<number[]> {
  const evs = (await prisma.siteConfigEvent.findMany({
    where: { site_id: siteId, kind: 'open_days' as any, voided_at: null },
    orderBy: [{ effective_date: 'asc' }, { created_at: 'asc' }],
    select: { effective_date: true, value_json: true, previous_json: true },
  })) as Array<{ effective_date: Date; value_json: any; previous_json: any }>;

  if (evs.length) {
    const atOrBefore = evs.filter((e) => e.effective_date.getTime() < to.getTime());
    if (atOrBefore.length) {
      const v = toDays(atOrBefore[atOrBefore.length - 1].value_json?.open_days);
      if (v) return v;
    } else {
      const prev = toDays(evs[0].previous_json?.open_days); // value BEFORE the first (later) change
      if (prev) return prev;
    }
  }
  return fallback ?? [];
}
