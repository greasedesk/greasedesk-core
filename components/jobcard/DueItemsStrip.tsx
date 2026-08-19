/**
 * File: components/jobcard/DueItemsStrip.tsx
 * WHAT THE CAR NEEDS, as the ESTIMATOR sees it — read-only, beside the estimate builder.
 *
 * ── WHY A STRIP AND NOT THE PANEL ───────────────────────────────────────────────────────────────
 * Two people, two moments. The mechanic RECORDS findings at the car; whoever prices them turns a
 * finding into a line at a desk. The full capture panel on the Quote tab put a form in the
 * estimator's way and buried the mechanic's job under quote actions, booking and send — different
 * activities on one screen, which is why it did not work.
 *
 * So the panel lives on Intake and this strip lives here: the estimator gets the INFORMATION
 * without the form, and nobody tab-switches mid-thought. Read-only on purpose — a finding is
 * captured where the car is.
 */
import React from 'react';
import { useTranslation } from 'next-i18next';
import type { DueItemView } from '@/components/jobcard/DueItems';

export default function DueItemsStrip({ items }: { items: DueItemView[] }) {
  const { t } = useTranslation('jobcard');
  if (!items.length) return null;
  return (
    <div className="bg-surface-muted border border-line rounded-xl px-4 py-3" data-testid="due-items-strip">
      <p className="text-xs uppercase tracking-wide text-muted mb-1.5">{t('dueItems.stripTitle')}</p>
      <ul className="space-y-1">
        {items.map((it) => (
          <li key={it.id} className="flex flex-wrap items-baseline gap-x-2 text-sm">
            <span className="text-ink">{it.description}</span>
            <span className="text-xs text-muted">{t(`dueItems.basis.${it.dueBasis}`, {
              date: it.dueDate ?? '', mileage: it.dueMileage != null ? it.dueMileage.toLocaleString('en-GB') : '',
            })}</span>
            {/* The customer's answer is the estimator's cue: `agreed_later` is what they asked to be
                priced, and it is the one worth making loud here. */}
            {it.customerResponse === 'agreed_later' && (
              <span className="text-xs font-semibold text-ok">{t('dueItems.stripWanted')}</span>
            )}
            {it.customerResponse === 'declined' && (
              <span className="text-xs text-muted">{t('dueItems.response.declined')}</span>
            )}
          </li>
        ))}
      </ul>
      <p className="text-xs text-muted mt-2">{t('dueItems.stripHint')}</p>
    </div>
  );
}
