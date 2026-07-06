/**
 * File: components/jobcard/JobCardTabs.tsx
 * The six-step process-path nav strip. Mobile-first: a horizontal scroll-snap row of step chips the
 * mechanic thumb-swipes on a phone (Customer Details pinned first). Each chip shows its state from the
 * gating chokepoint — tick = complete, open = reachable, lock = not yet. Locked chips are disabled
 * with a reason tooltip. Purely presentational; the parent owns active-tab state (kept in the URL).
 */
import React from 'react';
import type { TabKey } from '@/lib/jobcard-tabs';

export type TabView = { key: TabKey; label: string; reachable: boolean; complete: boolean; skipped?: boolean };

// booked = INFORMATIONAL spine chip (non-blocking, non-clickable) between Quote and Intake — a card
// can be worked without a diary slot; booking UI lives on the Quote tab.
type Props = { tabs: TabView[]; active: TabKey; onSelect: (k: TabKey) => void; lockedReason: string; booked?: { label: string; on: boolean } };

export default function JobCardTabs({ tabs, active, onSelect, lockedReason, booked }: Props) {
  return (
    // MOBILE (<md): the strip STICKS just under the 56px mobile header (bg-content so page text never
    // shows through while pinned) and side-scrolls — every tab reachable at 390px. md+: exactly as before.
    <div className="mb-5 -mx-4 px-4 sm:mx-0 sm:px-0 sticky top-14 z-20 bg-content pt-2 md:static md:top-auto md:z-auto md:bg-transparent md:pt-0">
      <div className="flex gap-2 overflow-x-auto snap-x snap-mandatory pb-2 [scrollbar-width:none] [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden">
        {tabs.map((t, i) => {
          const isActive = t.key === active;
          const locked = !t.reachable;
          const skippedLook = !!t.skipped && !isActive; // skipped advances but reads distinctly (amber »)
          const tone = isActive
            ? 'bg-accent text-white border-accent'
            : locked
              ? 'bg-surface-muted text-muted border-line opacity-60'
              : skippedLook
                ? 'bg-warn-soft text-warn border-line'
                : t.complete
                  ? 'bg-ok-soft text-ok border-line'
                  : 'bg-surface text-ink border-line';
          return (
            <React.Fragment key={t.key}>
              <button
                type="button"
                onClick={() => !locked && onSelect(t.key)}
                disabled={locked}
                title={locked ? lockedReason : undefined}
                aria-current={isActive ? 'step' : undefined}
                className={`snap-start shrink-0 flex items-center gap-2 rounded-xl border px-3 py-2.5 text-sm font-medium transition-colors ${tone} ${locked ? 'cursor-not-allowed' : 'cursor-pointer'}`}
              >
                <span className={`flex items-center justify-center w-5 h-5 rounded-full text-xs ${isActive ? 'bg-white/20' : t.skipped ? 'bg-warn text-white' : t.complete ? 'bg-ok text-white' : 'bg-surface-muted text-muted'}`}>
                  {t.skipped ? '»' : t.complete ? '✓' : locked ? '🔒' : i + 1}
                </span>
                <span className="whitespace-nowrap">{t.label}</span>
              </button>
              {t.key === 'quote' && booked && (
                <span aria-hidden className={`snap-start shrink-0 flex items-center gap-1.5 rounded-xl border border-dashed px-2.5 py-2.5 text-xs font-medium ${booked.on ? 'bg-ok-soft text-ok border-line' : 'bg-surface-muted text-muted border-line'}`}
                  title={booked.label}>
                  <span>{booked.on ? '✓' : '–'}</span>
                  <span className="whitespace-nowrap">{booked.label}</span>
                </span>
              )}
            </React.Fragment>
          );
        })}
      </div>
    </div>
  );
}
