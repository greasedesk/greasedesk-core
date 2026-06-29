/**
 * File: lib/trial.ts
 * Single source for trial length + helpers. Change TRIAL_DAYS here (one place) to adjust the
 * trial window for new signups / display. (Console-configurable length is a later slice.)
 */
export const TRIAL_DAYS = 60;

/** Trial end date for a signup happening now. */
export function trialEndsFromNow(): Date {
  return new Date(Date.now() + TRIAL_DAYS * 24 * 60 * 60 * 1000);
}

/** Whole days remaining until `end` (negative once past). null if no date. */
export function daysLeft(end: Date | string | null | undefined): number | null {
  if (!end) return null;
  const ms = new Date(end).getTime() - Date.now();
  return Math.ceil(ms / (24 * 60 * 60 * 1000));
}
