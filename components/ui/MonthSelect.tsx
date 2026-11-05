/**
 * File: components/ui/MonthSelect.tsx
 * A MONTH, PICKED THE SAME WAY IN EVERY BROWSER — two selects, producing `YYYY-MM`.
 *
 * ── WHAT IT REPLACES, AND WHY ───────────────────────────────────────────────────────────────────
 * `<input type="month">`, which desktop Firefox and desktop Safari do not implement. They fall back
 * to a plain text box, so the field offers no picker, no placeholder and no hint of the format —
 * and then KEEPS whatever is typed. Measured 2026-11-05 in Firefox 159: `input.type` reads back as
 * `'text'` and the value "12/2026" survives to be submitted, where Chrome 157 refuses it outright.
 * The server was right to reject those strings; the field was the defect.
 *
 * A `<select>` is one of the oldest elements there is. There is no support question left to ask,
 * which is why the gate's strongest clause is that no `type="month"` survives anywhere rather than
 * three browsers agreeing on a date picker.
 *
 * ── THE HALF-FILLED STATE, WHICH IS THE WHOLE DESIGN PROBLEM ────────────────────────────────────
 * A person picks a month, then a year. Between the two there is no value, and `composeMonth`
 * returns '' — which the parent stores and hands straight back down. If this component derived its
 * two selects from the prop alone, that echo would wipe the month they had just chosen.
 *
 * So it keeps both halves, and remembers the value it last EMITTED. A prop that differs from that
 * is a genuine outside change — a form seeding, a row being cleared — and resets both halves. A
 * prop equal to it is the parent echoing our own '' back, and is ignored. Without the `emitted`
 * half of that comparison, clearing the year would silently clear the month too.
 *
 * ── A BLANK IS A REAL ANSWER ────────────────────────────────────────────────────────────────────
 * Most schedule rows are empty, and a cost's "applies from" starts unset. Both selects carry a
 * blank option, and a blank in either means ''. There is no "please choose" validation here: the
 * screens that need one already refuse at save, with their own words.
 */
import React, { useState } from 'react';
import { MONTH_OPTIONS, pushDraft, seedDraft, syncDraft, yearOptions } from '@/lib/month-value';

type Props = {
  /** `YYYY-MM`, or '' for none. */
  value: string;
  onChange: (next: string) => void;
  disabled?: boolean;
  /** Prefix for the two selects' test ids and the month select's id, e.g. `schedule-month-oil`. */
  testId: string;
  /** What this month is, for a screen reader: "Next oil service due by". */
  label: string;
  className?: string;
  /** Today, injectable so the year range is provable without waiting a year. */
  now?: Date;
};

export default function MonthSelect({ value, onChange, disabled, testId, label, className, now }: Props) {
  const [s, setS] = useState(() => seedDraft(value));

  // THE OUTSIDE CHANGED, rather than the parent echoing what we just sent it — syncDraft is that one
  // comparison, and it lives in lib/month-value so a clause can be red about it. Adjusting state
  // during render is React's documented answer to "a prop changed and some state derives from it";
  // an effect would render once with the stale halves first, which on a seeded form is a visible
  // flash of the wrong month.
  const synced = syncDraft(s, value);
  if (synced !== s) setS(synced);

  const push = (change: { year?: number | null; month?: string }) => {
    const next = pushDraft(synced, change);
    setS(next);
    onChange(next.emitted);
  };

  const years = yearOptions(value, now);
  const sel = 'rounded border px-2 py-1 text-sm bg-surface border-line text-ink disabled:opacity-60';

  return (
    <span className={`inline-flex gap-1 ${className ?? ''}`} data-testid={testId}>
      <select
        id={testId}
        aria-label={`${label} — month`}
        value={synced.month}
        disabled={disabled}
        onChange={(e) => push({ month: e.target.value })}
        data-testid={`${testId}-month`}
        className={sel}
      >
        <option value="">Month</option>
        {MONTH_OPTIONS.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
      </select>
      <select
        aria-label={`${label} — year`}
        value={synced.year == null ? '' : String(synced.year)}
        disabled={disabled}
        onChange={(e) => push({ year: e.target.value === '' ? null : Number(e.target.value) })}
        data-testid={`${testId}-year`}
        className={sel}
      >
        <option value="">Year</option>
        {years.map((y) => <option key={y} value={y}>{y}</option>)}
      </select>
    </span>
  );
}
