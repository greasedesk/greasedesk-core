/**
 * File: lib/bank-holidays-ew.ts
 * England & Wales bank holidays, 2026 + 2027 — TRANSCRIBED from the official UK government feed
 * (https://www.gov.uk/bank-holidays.json, division "england-and-wales", fetched 2026-07-12).
 * Substitute days are already resolved IN the source data (e.g. 2026 Boxing Day falls Sat →
 * substitute Mon 28 Dec; Christmas Day 2027 falls Sat → substitute Mon 27 Dec). NEVER compute
 * these (no Easter algorithm, no weekend-substitution logic) — extend by transcribing the feed.
 * Shared by the admin "seed defaults" action; seeded with site_id = null (all group sites).
 */
export const EW_BANK_HOLIDAYS: Array<{ date: string; label: string }> = [
  { date: '2026-01-01', label: 'New Year’s Day' },
  { date: '2026-04-03', label: 'Good Friday' },
  { date: '2026-04-06', label: 'Easter Monday' },
  { date: '2026-05-04', label: 'Early May bank holiday' },
  { date: '2026-05-25', label: 'Spring bank holiday' },
  { date: '2026-08-31', label: 'Summer bank holiday' },
  { date: '2026-12-25', label: 'Christmas Day' },
  { date: '2026-12-28', label: 'Boxing Day (substitute day)' },
  { date: '2027-01-01', label: 'New Year’s Day' },
  { date: '2027-03-26', label: 'Good Friday' },
  { date: '2027-03-29', label: 'Easter Monday' },
  { date: '2027-05-03', label: 'Early May bank holiday' },
  { date: '2027-05-31', label: 'Spring bank holiday' },
  { date: '2027-08-30', label: 'Summer bank holiday' },
  { date: '2027-12-27', label: 'Christmas Day (substitute day)' },
  { date: '2027-12-28', label: 'Boxing Day (substitute day)' },
];
