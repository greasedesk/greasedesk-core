/**
 * File: components/jobcard/JobCardTabs.tsx
 * The six-step process-path nav strip. Mobile-first: a horizontal scroll-snap row of step chips the
 * mechanic thumb-swipes on a phone (Customer Details pinned first). Each chip shows its state from the
 * gating chokepoint — tick = complete, open = reachable, lock = not yet. Locked chips are disabled
 * with a reason tooltip. Purely presentational; the parent owns active-tab state (kept in the URL).
 */
import React from 'react';
import { NON_STAGE_TABS } from '@/lib/jobcard-tabs';
import type { TabKey } from '@/lib/jobcard-tabs';

export type TabView = { key: TabKey; label: string; reachable: boolean; complete: boolean; skipped?: boolean;
  /** A count to surface on the tab itself — today, unread messages. Absent means nothing waiting. */
  badge?: number };

// Booking is NOT a strip item (ruling 2026-07-07): it's part of the Quote — the standalone Booked
// chip is gone; the at-a-glance booked marker lives on the Quote tab beside the booking fields.
type Props = { tabs: TabView[]; active: TabKey; onSelect: (k: TabKey) => void; lockedReason: string };

export default function JobCardTabs({ tabs, active, onSelect, lockedReason }: Props) {
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
            <button
              key={t.key}
              type="button"
              onClick={() => !locked && onSelect(t.key)}
              data-testid={`tab-${t.key}`}
              disabled={locked}
              title={locked ? lockedReason : undefined}
              aria-current={isActive ? 'step' : undefined}
              className={`snap-start shrink-0 flex items-center gap-2 rounded-xl border px-3 py-2.5 text-sm font-medium transition-colors ${tone} ${locked ? 'cursor-not-allowed' : 'cursor-pointer'}`}
            >
              <span className={`flex items-center justify-center w-5 h-5 rounded-full text-xs ${isActive ? 'bg-white/20' : t.skipped ? 'bg-warn text-white' : t.complete ? 'bg-ok text-white' : 'bg-surface-muted text-muted'}`}>
                {/* A STEP NUMBER ONLY WHERE THERE IS A STEP. Messages and Refund are places to
                    look, not stages to finish — numbering them says "you are at step 8 of the job",
                    which is not true of a conversation or a refund. Read from NON_STAGE_TABS so the
                    next non-stage tab inherits it rather than picking up a number nobody meant.
                    (Messages wore a "2" for months; it read as an unread count and was its index.) */}
                {t.skipped ? '»' : t.complete ? '✓' : locked ? '🔒' : NON_STAGE_TABS.includes(t.key) ? '·' : i + 1}
              </span>
              <span className="whitespace-nowrap">{t.label}</span>
              {/* THE COUNT, on the tab. Distinct from the step number on the left: that circle says
                  where you are in the process, this says something is waiting for you. */}
              {typeof t.badge === 'number' && t.badge > 0 && (
                <span data-testid={`tab-badge-${t.key}`}
                  className="ml-0.5 inline-flex items-center justify-center min-w-[1.25rem] h-5 px-1.5 rounded-full text-[11px] font-semibold bg-danger text-white">
                  {t.badge}
                </span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}
