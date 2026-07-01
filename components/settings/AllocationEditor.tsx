/**
 * File: components/settings/AllocationEditor.tsx
 * Shared site-allocation editor for cost-capture (Headcount + Overheads). Repeatable
 * site + % rows with a live running total that must hit exactly 100% (basis-point check,
 * mirroring lib/cost-allocation.ts) before the parent form allows Save. Light theme, mobile-first.
 * Module-scope component + stable row keys so typing never remounts inputs.
 */
import React from 'react';
import type { TFunction } from 'i18next';

export type AllocRow = { key: string; siteId: string; percent: string };
export type SiteOpt = { id: string; name: string };

export const ALLOC_TOTAL_BP = 10000; // 100.00%
export const rowsBp = (rows: AllocRow[]): number =>
  rows.reduce((sum, r) => sum + Math.round((Number(r.percent) || 0) * 100), 0);
export const allocIsValid = (rows: AllocRow[]): boolean => {
  if (rows.length === 0) return false;
  const seen = new Set<string>();
  for (const r of rows) {
    const p = Number(r.percent);
    if (!r.siteId || !Number.isFinite(p) || p <= 0 || p > 100) return false;
    if (seen.has(r.siteId)) return false;
    seen.add(r.siteId);
  }
  return rowsBp(rows) === ALLOC_TOTAL_BP;
};

export default function AllocationEditor({
  sites, rows, onChange, t,
}: {
  sites: SiteOpt[];
  rows: AllocRow[];
  onChange: (rows: AllocRow[]) => void;
  t: TFunction;
}) {
  const totalBp = rowsBp(rows);
  const ok = totalBp === ALLOC_TOTAL_BP && rows.every((r) => r.siteId);
  const totalPct = (totalBp / 100).toFixed(totalBp % 100 === 0 ? 0 : 2);

  const setRow = (key: string, patch: Partial<AllocRow>) =>
    onChange(rows.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  const removeRow = (key: string) => onChange(rows.filter((r) => r.key !== key));
  const addRow = () => {
    const used = new Set(rows.map((r) => r.siteId));
    const next = sites.find((s) => !used.has(s.id));
    const remaining = Math.max(0, (ALLOC_TOTAL_BP - totalBp) / 100);
    onChange([
      ...rows,
      { key: `${next?.id || 'row'}-${rows.length}-${sites.length}`, siteId: next?.id || '', percent: remaining ? String(remaining) : '' },
    ]);
  };
  const canAdd = rows.length < sites.length;

  return (
    <div className="mt-4">
      <div className="flex items-center justify-between">
        <label className="text-sm font-medium text-ink">{t('allocation')}</label>
        <span
          className={`text-xs font-semibold px-2 py-0.5 rounded-full ${
            ok ? 'bg-ok-soft text-ok' : 'bg-danger-soft text-danger'
          }`}
        >
          {t('total')}: {totalPct}%{ok ? '' : ` · ${t('mustTotal')}`}
        </span>
      </div>
      <p className="text-xs text-muted mt-0.5">{t('allocationHint')}</p>

      <div className="mt-2 space-y-2">
        {rows.map((r) => (
          <div key={r.key} className="flex items-center gap-2">
            <select
              value={r.siteId}
              onChange={(e) => setRow(r.key, { siteId: e.target.value })}
              className="flex-1 min-w-0 bg-surface border border-line rounded-lg px-3 py-2 text-sm text-ink"
              aria-label={t('site')}
            >
              <option value="" disabled>{t('site')}</option>
              {sites.map((s) => (
                <option key={s.id} value={s.id}>{s.name}</option>
              ))}
            </select>
            <div className="relative w-24 shrink-0">
              <input
                type="number" inputMode="decimal" min={0} max={100} step="0.01"
                value={r.percent}
                onChange={(e) => setRow(r.key, { percent: e.target.value })}
                className="w-full bg-surface border border-line rounded-lg px-3 py-2 pr-7 text-sm text-ink text-right"
                aria-label={t('percent')}
              />
              <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-muted">%</span>
            </div>
            <button
              type="button" onClick={() => removeRow(r.key)}
              className="shrink-0 w-9 h-9 rounded-lg border border-line text-muted hover:text-danger hover:bg-danger-soft flex items-center justify-center"
              aria-label={t('delete')}
            >
              ×
            </button>
          </div>
        ))}
      </div>

      {canAdd && (
        <button
          type="button" onClick={addRow}
          className="mt-2 text-sm text-accent hover:underline font-medium"
        >
          + {t('addSite')}
        </button>
      )}
    </div>
  );
}
