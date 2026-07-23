/**
 * File: components/dashboard/CapacityChart.tsx
 * The dashboard's headline burn-up: TWO cumulative labour-hour lines across the month.
 *   • Capacity pace (target) — dashed, muted: sellable hours accruing on working days.
 *   • Billed — ok/green: hours charged, dated by invoice date.
 * Each line ends in a right-gutter label (small title above, large figure) — no legend. Labels
 * vertically separate when the line ends converge. Pure inline SVG (no chart dependency), theme-safe
 * via currentColor + semantic text tokens. Billed is drawn only up to `elapsed` (live month = today).
 */
import React from 'react';

export type CapacitySeriesPoint = { day: number; capacity: number; billed: number };
type EndLabel = { title: string; value: string };
type Props = {
  series: CapacitySeriesPoint[];
  daysInMonth: number;
  elapsed: number; // draw billed up to this day-of-month (= daysInMonth for a closed month)
  maxY: number;    // Y-axis top, in hours
  hoursLabel: string;
  ends: { capacity: EndLabel; billed: EndLabel };
  locale: string;
};

const W = 720, H = 260, padL = 44, padR = 140, padT = 14, padB = 28;
const plotW = W - padL - padR, plotH = H - padT - padB;
const plotRight = padL + plotW;

export default function CapacityChart({ series, daysInMonth, elapsed, maxY, hoursLabel, ends, locale }: Props) {
  if (!series.length || maxY <= 0) return null;
  const x = (day: number) => padL + (daysInMonth <= 1 ? 0 : ((day - 1) / (daysInMonth - 1)) * plotW);
  const y = (v: number) => padT + plotH - (Math.max(0, Math.min(v, maxY)) / maxY) * plotH;
  const poly = (pts: CapacitySeriesPoint[], key: 'capacity' | 'billed') => pts.map((p) => `${x(p.day).toFixed(1)},${y(p[key]).toFixed(1)}`).join(' ');

  const billedPts = series.filter((p) => p.day <= elapsed);
  const capEnd = series[series.length - 1];
  const billEnd = billedPts[billedPts.length - 1] ?? series[0];
  const yTicks = [0, 0.25, 0.5, 0.75, 1].map((f) => Math.round(maxY * f));
  const xTicks = Array.from(new Set([1, 8, 15, 22, 29, daysInMonth].filter((d) => d >= 1 && d <= daysInMonth)));
  const fmtH = (n: number) => n.toLocaleString(locale, { maximumFractionDigits: 0 });

  // End-label vertical centres, separated when the two line ends converge. Order preserved.
  const GAP = 34;
  let capC = y(capEnd.capacity), billC = y(billEnd.billed);
  if (Math.abs(capC - billC) < GAP) {
    const mid = (capC + billC) / 2;
    if (capC <= billC) { capC = mid - GAP / 2; billC = mid + GAP / 2; } else { capC = mid + GAP / 2; billC = mid - GAP / 2; }
  }
  const clampY = (v: number) => Math.max(padT + 10, Math.min(padT + plotH - 6, v));
  capC = clampY(capC); billC = clampY(billC);

  const EndTag = ({ cy, title, value, tone }: { cy: number; title: string; value: string; tone: string }) => (
    <g>
      <text x={plotRight + 8} y={cy - 6} className="text-muted fill-current text-[9px] uppercase tracking-wide">{title}</text>
      <text x={plotRight + 8} y={cy + 9} className={`${tone} fill-current text-[15px] font-bold`}>{value}</text>
    </g>
  );

  return (
    <div className="w-full overflow-x-auto">
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-auto min-w-[560px]" role="img" aria-label="Cumulative sellable-capacity and billed labour hours across the month">
        {/* Y grid + labels */}
        {yTicks.map((t) => (
          <g key={t}>
            <line x1={padL} y1={y(t)} x2={plotRight} y2={y(t)} className="text-line" stroke="currentColor" strokeWidth={1} opacity={0.4} />
            <text x={padL - 6} y={y(t) + 3} textAnchor="end" className="text-muted fill-current text-[10px]">{fmtH(t)}</text>
          </g>
        ))}
        <text x={12} y={padT + 8} className="text-muted fill-current text-[10px]" transform={`rotate(-90 12 ${padT + plotH / 2})`} style={{ transformBox: 'fill-box' }}>{hoursLabel}</text>
        {/* X labels */}
        {xTicks.map((d) => (
          <text key={d} x={x(d)} y={H - 8} textAnchor="middle" className="text-muted fill-current text-[10px]">{d}</text>
        ))}
        {/* today marker (in-progress only) */}
        {elapsed < daysInMonth && (
          <line x1={x(elapsed)} y1={padT} x2={x(elapsed)} y2={padT + plotH} className="text-accent" stroke="currentColor" strokeWidth={1} strokeDasharray="2 3" opacity={0.6} />
        )}
        {/* Capacity pace (target) — dashed, muted */}
        <polyline points={poly(series, 'capacity')} fill="none" className="text-muted" stroke="currentColor" strokeWidth={2} strokeDasharray="5 4" />
        {/* Billed — ok */}
        <polyline points={poly(billedPts, 'billed')} fill="none" className="text-ok" stroke="currentColor" strokeWidth={2.5} />
        {/* line-end dots */}
        <circle cx={x(capEnd.day)} cy={y(capEnd.capacity)} r={2.5} className="text-muted fill-current" />
        <circle cx={x(billEnd.day)} cy={y(billEnd.billed)} r={2.5} className="text-ok fill-current" />
        {/* end labels (right gutter) */}
        <EndTag cy={capC} title={ends.capacity.title} value={ends.capacity.value} tone="text-ink" />
        <EndTag cy={billC} title={ends.billed.title} value={ends.billed.value} tone="text-ok" />
      </svg>
    </div>
  );
}
