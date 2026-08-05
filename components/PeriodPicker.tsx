/**
 * File: components/PeriodPicker.tsx
 * THE period control. One selector, one place — the dashboard and the quotes panel render this
 * same component, so the twelve rolling months, the year grouping and the FY labels cannot drift
 * apart the way a copied dropdown would.
 *
 * It owns the SELECTION and nothing else. Each screen decides what to do with it: the dashboard
 * needs a cash range AND a whole-month span for the P&L strip; quotes needs the cash range only.
 * Putting that mapping in here would drag the P&L's month rules onto every screen that ever wants
 * a date filter.
 *
 * Labels come from lib/dashboard-periods, beside the ranges they name — a label that drifts from
 * its range is the bug that file exists to prevent.
 */
import React, { useEffect, useState } from 'react';
import { useTranslation } from 'next-i18next';
import { monthGroups, fyRangeLabel } from '@/lib/dashboard-periods';

export type PeriodSelection = { preset: string; customFrom: string; customTo: string };

type Props = {
  value: PeriodSelection;
  onChange: (v: PeriodSelection) => void;
  fyStartMonth: number;
  locale: string;
  /** Stable per-tenant, per-screen key. Null disables persistence. */
  storageKey: string | null;
  className?: string;
};

const SELECT_CLASS = 'p-2 bg-surface border border-line rounded-lg text-ink text-sm focus:ring-accent focus:border-accent';

export default function PeriodPicker({ value, onChange, fyStartMonth, locale, storageKey, className }: Props) {
  const { t } = useTranslation('period');
  const now = new Date(); // labels only — the SERVER resolves every window
  const groups = monthGroups(now, locale, {
    thisMonth: (m) => t('thisMonthNamed', { month: m }),
    lastMonth: (m) => t('lastMonthNamed', { month: m }),
  });

  // Restore ONCE on mount, client-only, so the first client render still matches SSR. A stored
  // selection the user can no longer see — a month that has rolled off, a half-finished custom
  // range — is NOT restored: it falls back to the default rather than showing a period the
  // dropdown does not offer.
  const [restored, setRestored] = useState(false);
  useEffect(() => {
    if (restored || !storageKey) { setRestored(true); return; }
    try {
      const raw = localStorage.getItem(storageKey);
      if (raw) {
        const s = JSON.parse(raw) as Partial<PeriodSelection>;
        const valid = new Set<string>(['this_quarter', 'last_quarter', 'this_fy', 'last_fy', 'custom',
          ...groups.flatMap((g) => g.options.map((o) => o.value))]);
        if (s.preset && valid.has(s.preset) && !(s.preset === 'custom' && !(s.customFrom && s.customTo))) {
          onChange({ preset: s.preset, customFrom: s.customFrom ?? '', customTo: s.customTo ?? '' });
        }
      }
    } catch { /* unreadable storage is not a reason to fail the screen */ }
    setRestored(true);
  }, [restored, storageKey]);   // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!restored || !storageKey) return;
    try { localStorage.setItem(storageKey, JSON.stringify(value)); } catch { /* non-fatal */ }
  }, [restored, storageKey, value]);

  return (
    <div className={`flex flex-wrap items-center gap-2 ${className ?? ''}`}>
      <select
        value={value.preset}
        onChange={(e) => onChange({ ...value, preset: e.target.value })}
        className={SELECT_CLASS}
        aria-label={t('groupOther')}
        data-testid="period-picker"
      >
        {groups.map((g) => (
          <optgroup key={g.year} label={t('groupMonthsYear', { year: g.year })}>
            {g.options.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
          </optgroup>
        ))}
        <optgroup label={t('groupQuarters')}>
          <option value="this_quarter">{t('this_quarter')}</option>
          <option value="last_quarter">{t('last_quarter')}</option>
        </optgroup>
        <optgroup label={t('groupFy')}>
          <option value="this_fy">{t('thisFyRange', { range: fyRangeLabel(now, fyStartMonth, 0, locale) })}</option>
          <option value="last_fy">{t('lastFyRange', { range: fyRangeLabel(now, fyStartMonth, -1, locale) })}</option>
        </optgroup>
        <optgroup label={t('groupOther')}>
          <option value="custom">{t('custom')}</option>
        </optgroup>
      </select>
      {value.preset === 'custom' && (
        <>
          <input type="date" value={value.customFrom} onChange={(e) => onChange({ ...value, customFrom: e.target.value })}
            className="p-2 bg-surface border border-line rounded-lg text-ink text-sm" data-testid="period-from" />
          <span className="text-muted text-sm">→</span>
          <input type="date" value={value.customTo} onChange={(e) => onChange({ ...value, customTo: e.target.value })}
            className="p-2 bg-surface border border-line rounded-lg text-ink text-sm" data-testid="period-to" />
        </>
      )}
    </div>
  );
}
