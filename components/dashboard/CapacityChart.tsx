/**
 * File: components/dashboard/CapacityChart.tsx
 * The dashboard's headline burn-up: three CUMULATIVE labour-hour lines across the month.
 *   • Capacity pace (target) — dashed, muted: sellable hours accruing on working days.
 *   • Committed — accent: hours taken on (WIP job cards, dated by diary date).
 *   • Billed — ok/green: hours charged, dated by invoice date.
 * Pure inline SVG (no chart dependency), theme-safe via currentColor + semantic text tokens.
 * Committed/Billed are drawn only up to `elapsed` so a live month reads as in-flight, not failed.
 */
import React from 'react';

export type CapacitySeriesPoint = { day: number; capacity: number; committed: number; billed: number };
type Props = {
  series: CapacitySeriesPoint[];
  daysInMonth: number;
  elapsed: number; // draw committed/billed up to this day-of-month (= daysInMonth for a closed month)
  maxY: number;    // Y-axis top, in hours
  labels: { capacity: string; committed: string; billed: string; hours: string };
  locale: string;
};

const W = 720, H = 260, padL = 44, padR = 12, padT = 12, padB = 28;
const plotW = W - padL - padR, plotH = H - padT - padB;

export default function CapacityChart({ series, daysInMonth, elapsed, maxY, labels, locale }: Props) {
  if (!series.length || maxY <= 0) return null;
  const x = (day: number) => padL + (daysInMonth <= 1 ? 0 : ((day - 1) / (daysInMonth - 1)) * plotW);
  const y = (v: number) => padT + plotH - (Math.max(0, Math.min(v, maxY)) / maxY) * plotH;
  const line = (pts: CapacitySeriesPoint[], key: 'capacity' | 'committed' | 'billed') =>
    pts.map((p) => `${x(p.day).toFixed(1)},${y(p[key]).toFixed(1)}`).join(' ');

  const upto = series.filter((p) => p.day <= elapsed);
  const yTicks = [0, 0.25, 0.5, 0.75, 1].map((f) => Math.round(maxY * f));
  // ~weekly x ticks + the last day.
  const xTicks = Array.from(new Set([1, 8, 15, 22, 29, daysInMonth].filter((d) => d >= 1 && d <= daysInMonth)));
  const fmtH = (n: number) => n.toLocaleString(locale, { maximumFractionDigits: 0 });

  return (
    <div>
      <div className="w-full overflow-x-auto">
        <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-auto min-w-[520px]" role="img" aria-label="Cumulative capacity, committed and billed labour hours across the month">
          {/* Y grid + labels */}
          {yTicks.map((t) => (
            <g key={t}>
              <line x1={padL} y1={y(t)} x2={W - padR} y2={y(t)} className="text-line" stroke="currentColor" strokeWidth={1} opacity={0.4} />
              <text x={padL - 6} y={y(t) + 3} textAnchor="end" className="text-muted fill-current text-[10px]">{fmtH(t)}</text>
            </g>
          ))}
          <text x={12} y={padT + 8} className="text-muted fill-current text-[10px]" transform={`rotate(-90 12 ${padT + plotH / 2})`} style={{ transformBox: 'fill-box' }}>{labels.hours}</text>
          {/* X labels */}
          {xTicks.map((d) => (
            <text key={d} x={x(d)} y={H - 8} textAnchor="middle" className="text-muted fill-current text-[10px]">{d}</text>
          ))}
          {/* today marker (in-progress only) */}
          {elapsed < daysInMonth && (
            <line x1={x(elapsed)} y1={padT} x2={x(elapsed)} y2={padT + plotH} className="text-accent" stroke="currentColor" strokeWidth={1} strokeDasharray="2 3" opacity={0.6} />
          )}
          {/* Capacity pace (target) — dashed, muted */}
          <polyline points={line(series, 'capacity')} fill="none" className="text-muted" stroke="currentColor" strokeWidth={2} strokeDasharray="5 4" />
          {/* Committed — accent */}
          <polyline points={line(upto, 'committed')} fill="none" className="text-accent" stroke="currentColor" strokeWidth={2.5} />
          {/* Billed — ok */}
          <polyline points={line(upto, 'billed')} fill="none" className="text-ok" stroke="currentColor" strokeWidth={2.5} />
        </svg>
      </div>
      <div className="flex flex-wrap gap-x-5 gap-y-1 mt-2 text-xs">
        <span className="inline-flex items-center gap-1.5 text-muted"><svg width="18" height="6"><line x1="0" y1="3" x2="18" y2="3" stroke="currentColor" strokeWidth="2" strokeDasharray="5 4" /></svg>{labels.capacity}</span>
        <span className="inline-flex items-center gap-1.5 text-accent"><svg width="18" height="6"><line x1="0" y1="3" x2="18" y2="3" stroke="currentColor" strokeWidth="2.5" /></svg>{labels.committed}</span>
        <span className="inline-flex items-center gap-1.5 text-ok"><svg width="18" height="6"><line x1="0" y1="3" x2="18" y2="3" stroke="currentColor" strokeWidth="2.5" /></svg>{labels.billed}</span>
      </div>
    </div>
  );
}
