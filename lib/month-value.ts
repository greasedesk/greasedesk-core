/**
 * File: lib/month-value.ts
 * A MONTH, AS A VALUE — the one definition of `YYYY-MM`, and the year range a picker offers.
 *
 * PURE, and it imports nothing: the component that uses it renders on a phone, and a module that
 * reached the database could not be imported there without shipping Prisma to the browser
 * (leaf-module-for-client-constants — lib/prospects and lib/marketing-engine exist for the same
 * reason).
 *
 * ── WHY THIS FILE EXISTS ────────────────────────────────────────────────────────────────────────
 * `<input type="month">` is unsupported in desktop Firefox and desktop Safari, where it silently
 * falls back to a plain text box. Measured 2026-11-05: Firefox 159 reports `input.type === 'text'`
 * and KEEPS the string "12/2026", which the form then submits. Chrome 157 reports `'month'` and
 * refuses the same string outright. So the five of these in the product were a field two of the
 * three desktop browsers could not fill in at all.
 *
 * The replacement is two `<select>`s, which behave identically everywhere. This module holds the
 * part that is a rule rather than markup, so the rules can be proved without a browser and the
 * server can share the one parser.
 *
 * ── THE SHAPE IS THE SAME ONE THE SERVER ALREADY DEMANDED ───────────────────────────────────────
 * lib/service-schedule::monthToStoredDate reads MONTH_RE from here rather than carrying its own
 * copy. Two regexes for one format is how a value a form produces stops matching the value an API
 * accepts, with nothing to point at (identical-by-construction).
 */

/** `YYYY-MM`, and nothing else. Not a date: a month has no day, and inventing one is the caller's job. */
export const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

export const isMonthValue = (v: unknown): v is string => typeof v === 'string' && MONTH_RE.test(v);

/** The two halves, or null when the string is not a month. Never a partial answer. */
export function splitMonth(v: string | null | undefined): { year: number; month: string } | null {
  if (!isMonthValue(v)) return null;
  const [y, m] = (v as string).split('-');
  return { year: Number(y), month: m };
}

/**
 * Back to `YYYY-MM`, or '' when either half is missing.
 *
 * A HALF-ANSWER IS NOT A VALUE. Somebody mid-way through picking has chosen a month and no year;
 * emitting "2026-" or "-11" would put a string nothing can parse into the form's state, and the
 * first thing to see it would be the server. '' is what the rest of the product already means by
 * "no month given", so a half-filled picker is simply not yet an answer.
 */
export function composeMonth(year: number | string | null | undefined, month: string | null | undefined): string {
  const y = String(year ?? '').trim();
  const m = String(month ?? '').trim();
  if (!/^\d{4}$/.test(y) || !/^(0[1-9]|1[0-2])$/.test(m)) return '';
  return `${y}-${m}`;
}

/** Jan–Dec, with the two-digit values the format needs. Labels are short: a row is narrow. */
export const MONTH_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
  ['01', 'Jan'], ['02', 'Feb'], ['03', 'Mar'], ['04', 'Apr'], ['05', 'May'], ['06', 'Jun'],
  ['07', 'Jul'], ['08', 'Aug'], ['09', 'Sep'], ['10', 'Oct'], ['11', 'Nov'], ['12', 'Dec'],
].map(([value, label]) => ({ value, label }));

/** How far either side of this year the picker offers (owner, 2026-11-05). */
export const YEAR_SPAN = 5;

/**
 * THE YEARS TO OFFER, AND THE ONE RULE THAT MATTERS MORE THAN THE RANGE.
 *
 * The range is this year ±5. But a stored value may sit outside it — a schedule row recorded two
 * visits ago and now long overdue, or a reporting anchor set when the garage opened — and a picker
 * that cannot represent what is already saved does not merely look wrong: loading the form would
 * change the value, and saving it back would write the change. A RELOAD MUST NEVER EDIT A STORED
 * VALUE, so the loaded year is added to the list whenever it falls outside.
 *
 * Added rather than the range being widened to reach it: widening to 1998 would offer every year
 * between as though they were ordinary choices. One extra option says what is true — this value is
 * from outside the normal range, and it is still exactly what was saved.
 */
export function yearOptions(value: string | null | undefined, now: Date = new Date()): number[] {
  const thisYear = now.getUTCFullYear();
  const years: number[] = [];
  for (let y = thisYear - YEAR_SPAN; y <= thisYear + YEAR_SPAN; y += 1) years.push(y);
  const loaded = splitMonth(value)?.year;
  if (loaded != null && !years.includes(loaded)) years.push(loaded);
  return years.sort((a, b) => a - b);
}

/** "November 2026" — for reading back a stored month in prose, where a form is not the point. */
export function monthLabel(v: string | null | undefined): string | null {
  const parts = splitMonth(v);
  if (!parts) return null;
  const long = ['January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'];
  return `${long[Number(parts.month) - 1]} ${parts.year}`;
}

// ── THE TWO-HALVES STATE, AS A RULE RATHER THAN AS COMPONENT INTERNALS ──────────────────────────
/**
 * WHAT A HALF-FILLED PICKER IS HOLDING.
 *
 * `emitted` is the value the picker last sent UP. It is not bookkeeping: without it the picker
 * cannot tell its parent echoing back the '' it just produced from the outside genuinely clearing
 * the field, and the two need opposite responses. This lived inside the component, where the one
 * rule most likely to be got wrong was also the one nothing could assert. It is here so a clause
 * can be red about it.
 */
export type MonthDraft = { year: number | null; month: string; emitted: string };

/** The halves a value arrives as. A non-month (including '') is two empty halves. */
export function seedDraft(value: string | null | undefined): MonthDraft {
  const parts = splitMonth(value);
  return { year: parts?.year ?? null, month: parts?.month ?? '', emitted: value ?? '' };
}

/**
 * THE INCOMING PROP, RECONCILED.
 *
 * Returns the draft to use. The rule is one comparison and it is the whole design:
 *
 *   value === prev.emitted   the parent is handing back what we just sent it. KEEP the halves —
 *                            somebody who has picked a month and no year yet is holding a '' that
 *                            is theirs, and reseeding from it would wipe the month they chose.
 *   value !== prev.emitted   the outside changed it: a form seeded, a row cleared by a reset, a
 *                            different card loaded. RESEED, because the halves are now stale.
 *
 * Clearing the YEAR on a complete value is the case that makes this necessary and is easy to get
 * wrong: the picker emits '', the parent echoes '', and a naive reseed would clear the month too —
 * so the person loses a field they did not touch.
 */
export function syncDraft(prev: MonthDraft, value: string | null | undefined): MonthDraft {
  const v = value ?? '';
  return v === prev.emitted ? prev : seedDraft(v);
}

/** One half changed. Returns the next draft, carrying what it will emit so `syncDraft` can tell. */
export function pushDraft(prev: MonthDraft, change: { year?: number | null; month?: string }): MonthDraft {
  const year = change.year === undefined ? prev.year : change.year;
  const month = change.month === undefined ? prev.month : change.month;
  return { year, month, emitted: composeMonth(year, month) };
}
