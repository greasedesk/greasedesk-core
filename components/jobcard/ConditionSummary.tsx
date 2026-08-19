/**
 * File: components/jobcard/ConditionSummary.tsx
 * WHAT THE CAR ALREADY SAYS — shown above the form that captures it.
 *
 * ── WHY THIS COMPONENT EXISTS ───────────────────────────────────────────────────────────────────
 * The tyre and battery capture forms were WRITE-ONLY. They initialised blank and were never told
 * what the car already said, so a mechanic had no way to see a reading they had just taken. On a
 * real MINI that meant four corners at 4.0mm and a battery at 76% health were visible on the
 * CUSTOMER'S report and nowhere on the job card — because both were healthy, so neither raised a
 * finding, and findings were the only intake data the card could render.
 *
 * Note the direction of the failure: a WORN tyre would at least have appeared as an advisory. It is
 * the reassuring reading that disappears, and that is exactly the one a mechanic wants to confirm.
 *
 * The values come from lib/vehicle-condition — the same reader the customer report uses — so this
 * cannot drift from what was sent. Read-only by construction: no inputs, no handlers.
 */
import React from 'react';
import type { TyreCondition, BatteryCondition } from '@/lib/vehicle-condition';

const BAND_TONE: Record<TyreCondition['band'], string> = {
  illegal: 'border-danger bg-danger-soft text-danger',
  advise: 'border-warn bg-warn-soft text-warn',
  ok: 'border-line bg-surface-muted text-ink',
};

const STATE_TONE: Record<string, string> = {
  dead_cell: 'border-danger bg-danger-soft text-danger',
  replace: 'border-danger bg-danger-soft text-danger',
  monitor: 'border-warn bg-warn-soft text-warn',
  charging_fault: 'border-warn bg-warn-soft text-warn',
  retest: 'border-warn bg-warn-soft text-warn',
  ok: 'border-line bg-surface-muted text-ink',
};

export function TyreSummary({ tyres }: { tyres: TyreCondition[] }) {
  // NOTHING RECORDED is said out loud rather than rendered as an absence — a blank space is what
  // this component exists to stop, and an empty grid would be the same mistake in a new place.
  if (!tyres.length) {
    return (
      <p className="text-xs text-muted mb-3" data-testid="tyre-summary-none">
        No tyre readings recorded for this car yet.
      </p>
    );
  }
  return (
    <div className="mb-3" data-testid="tyre-summary">
      <p className="text-xs text-muted mb-1.5">Recorded for this car</p>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        {tyres.map((t) => (
          <div key={t.corner} className={`rounded-lg border p-2 ${BAND_TONE[t.band]}`} data-testid={`tyre-summary-${t.corner}`}>
            <p className="text-[11px] opacity-70">{t.label}</p>
            <p className="text-lg font-bold tabular-nums leading-tight">
              {t.lowest}<span className="text-xs font-medium">mm</span>
            </p>
            <p className="text-[11px] opacity-70 tabular-nums">{t.outer} / {t.centre} / {t.inner}</p>
            {t.unevenEdge && <p className="text-[11px] font-medium">Worn {t.unevenEdge} edge</p>}
            {/* The DATE, because a corner not re-measured today is still the truth about that
                corner — and a mechanic needs to know which of those they are looking at. */}
            <p className="text-[10px] opacity-60">{t.measuredOn}</p>
          </div>
        ))}
      </div>
    </div>
  );
}

export function BatterySummary({ battery }: { battery: BatteryCondition | null }) {
  if (!battery) {
    return (
      <p className="text-xs text-muted mb-3" data-testid="battery-summary-none">
        No battery test recorded for this car yet.
      </p>
    );
  }
  return (
    <div className={`mb-3 rounded-lg border p-2.5 ${STATE_TONE[battery.state] ?? STATE_TONE.ok}`} data-testid="battery-summary">
      <p className="text-[11px] opacity-70 mb-1">Recorded for this car — {battery.measuredOn}</p>
      <div className="flex flex-wrap gap-x-5 gap-y-1">
        <span className="text-sm font-semibold tabular-nums" data-testid="battery-summary-soh">{battery.sohPct}% health</span>
        <span className="text-sm tabular-nums" data-testid="battery-summary-soc">{battery.socPct}% charge</span>
        <span className="text-sm tabular-nums" data-testid="battery-summary-voltage">{battery.voltage}V</span>
      </div>
      {/* The advisory in lib/battery's own words, so the card cannot describe a reading differently
          from the way the customer's report described it. */}
      {battery.advisory && <p className="text-xs mt-1.5" data-testid="battery-summary-advisory">{battery.advisory}</p>}
      {battery.ratedCca && battery.ccaStandard && (
        <p className="text-[10px] opacity-60 mt-1">against {battery.ratedCca} CCA {battery.ccaStandard}</p>
      )}
    </div>
  );
}
