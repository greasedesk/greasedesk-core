/**
 * File: lib/trial.ts
 * Pure trial date arithmetic, with NO database behind it — safe for a client bundle.
 *
 * THE TRIAL LENGTH IS NOT HERE ANY MORE. It was an exported constant here, one of two that had to
 * be changed together, and a comment that said so. It is a setting now:
 * lib/programme-settings owns it, and trialEndsAt() lives there because reading it needs the
 * database. This module keeps only what a rendered page can safely ask.
 */

/** Whole days remaining until `end` (negative once past). null if no date. */
export function daysLeft(end: Date | string | null | undefined): number | null {
  if (!end) return null;
  const ms = new Date(end).getTime() - Date.now();
  return Math.ceil(ms / (24 * 60 * 60 * 1000));
}
