/**
 * File: lib/diary-time.ts
 * THE one place a diary time is rendered (desktop + /m — one chokepoint, never a second
 * implementation). Diary start_at/end_at are stored as a FLOATING wall-clock tagged UTC (a 9am
 * booking is 09:00:00.000Z — the wall clock the garage typed, not a true instant). So display is
 * the stored UTC digits, verbatim: NO timezone conversion (converting a floating time through a zone
 * re-applies the offset and shifts every British booking by the BST hour — the exact bug this fixes).
 *
 * Site.timezone exists but is deliberately NOT consulted here: it becomes load-bearing only for
 * TRUE-INSTANT operations (cross-zone reminders, overdue-vs-now, ICS export), which first need a
 * migration re-interpreting stored floating times into real UTC. Until then, the wall clock is the
 * truth and this renders it.
 */

/** "HH:MM" from a floating-wall-clock ISO (the diary convention). */
export function hhmm(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toISOString().slice(11, 16);
}
