/**
 * File: lib/calendar-days.ts
 * WHOLE DAYS BETWEEN TWO CALENDAR DAYS — the one day-count primitive, extracted so the surfaces
 * that print "N days" cannot drift apart.
 *
 * It floors to the DATE, not the instant. That distinction has already caused one live defect: a
 * `@db.Date` MOT expiry read as midnight and subtracted as an instant under-counts by up to a day,
 * and the leads board printed "28 days" for a 29-day date. The rule everywhere is the one a person
 * uses — a date that falls today is 0, tomorrow is 1 — and an instant 16 hours ago is 1 day if it
 * was yesterday, because "since yesterday" is what somebody standing in the workshop says.
 *
 * A leaf module on purpose: no imports, so a client bundle can read it without dragging anything.
 */
export const calendarDayDiff = (from: Date, to: Date): number => {
  const a = Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate());
  const b = Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), to.getUTCDate());
  return Math.floor((b - a) / 86_400_000);
};
