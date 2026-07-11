/**
 * File: lib/rostered-days.ts
 * THE rostered-day decision — ISOMORPHIC (no prisma) so the Headcount form can show the
 * inherited default with the same rule capacity computes with. lib/capacity re-exports these;
 * server code keeps importing from there. Never re-derive the inheritance or the weekday test.
 */
export const dayKey = (d: Date) => d.toISOString().slice(0, 10);

/** A person's rostered weekday set: explicit working_days, else the site's open_days. */
export const rosteredWeekdays = (workingDays: number[], siteOpenDays: number[] | null | undefined): number[] =>
  workingDays.length ? workingDays : (siteOpenDays ?? []);

/** Is calendar date d a rostered (working) day for that weekday set? */
export const isRosteredOn = (rostered: number[], d: Date): boolean => rostered.includes(d.getUTCDay());
