/**
 * File: components/dashboard/CapacityMonthsChart.tsx
 * TWELVE MONTHS, SIDE BY SIDE: sellable labour value against what was actually sold.
 *
 * The burn-up next door answers "am I on pace this month". This answers a different question —
 * which months did the garage sell its capacity, and which did it not — and the answer is the GAP
 * between the two bars. So the gap is the thing the design protects: two flat bars on one baseline,
 * the sold bar drawn IN FRONT of the sellable one from the same origin, no depth, no 3D, no
 * stacking. Anything that makes the remainder ambiguous defeats the view.
 *
 * ── FOUR STATES, DELIBERATELY UNALIKE ───────────────────────────────────────────────────────────
 *   ABSENT   the tenant did not exist that month → no bar at all, just the month label. A
 *            zero-height bar would say "we sold nothing", which is a claim about a month nobody
 *            lived through.
 *   NO RATIO sellable is 0 (no capacity configured) → a bar cannot be drawn and NO percentage is
 *            printed. Unknown is not nought.
 *   ZERO     trading, sold nothing → the full sellable bar with no sold bar in front, and a printed
 *            0%. A real and terrible number that must not be hidden.
 *   PARTIAL  the live month, drawn only to the elapsed day, hatched and marked. On day 10 of 31 a
 *            full-height sellable bar would read as a collapse in sales.
 *
 * ── ONE LIGHT, NOT TWELVE ───────────────────────────────────────────────────────────────────────
 * utilisationLight judges sold-to-date ÷ available-to-date at the elapsed day — a statement about
 * PACE inside a live month. Twelve of them would be twelve subtly different claims wearing the same
 * three colours. The percentages carry the comparison; colour is reserved for the current month.
 */
import React from 'react';
import type { CapacityLight } from '@/components/dashboard/CapacityChart';

export type MonthBar = {
  key: string;              // YYYY-MM
  label: string;            // "Sep", and "Sep 25" at a year boundary
  sellablePennies: number | null;
  soldPennies: number;
  ratio: number | null;     // null = no capacity configured; NOT zero
  absent: boolean;          // before the tenant's first record
  live: boolean;            // the current, incomplete month
  elapsedFraction: number;  // live month only: how much of it has happened (0..1)
};

type Props = {
  bars: MonthBar[];
  money: (pennies: number) => string;
  /** Current month only. Absent when there is nothing to judge. */
  light?: CapacityLight;
  labels: { sellable: string; sold: string; partial: string; noData: string; noCapacity: string };
};

const W = 720, H = 300, padL = 56, padR = 16, padT = 34, padB = 46;
const plotW = W - padL - padR, plotH = H - padT - padB;

export default function CapacityMonthsChart({ bars, money, light, labels }: Props) {
  if (!bars.length) return null;
  // The axis is driven by SELLABLE, which is always the taller of the pair — except where a garage
  // beat its capacity, which must not be clipped off the top.
  const maxY = Math.max(1, ...bars.map((b) => Math.max(b.sellablePennies ?? 0, b.soldPennies)));
  const slot = plotW / bars.length;
  const backW = Math.min(38, slot * 0.62);   // sellable — the lighter, wider bar behind
  const frontW = backW * 0.58;               // sold — solid, in front, same baseline
  const baseY = padT + plotH;
  const h = (p: number) => (p / maxY) * plotH;
  const cx = (i: number) => padL + slot * i + slot / 2;

  const yTicks = [0, 0.5, 1].map((f) => Math.round(maxY * f));
  const lit = light ? ({ red: 'text-danger', amber: 'text-warn', green: 'text-ok' } as const)[light.colour] : null;

  return (
    <div className="w-full overflow-x-auto">
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-auto min-w-[620px]" role="img"
        aria-label="Sellable labour value against labour value sold, for each of the last twelve months">
        <defs>
          {/* The live month is hatched rather than merely paler — a lighter shade reads as a smaller
              number, and this bar is not smaller, it is shorter because the month is not over. */}
          <pattern id="cm-partial" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
            <rect width="6" height="6" className="text-muted fill-current" opacity={0.18} />
            <line x1="0" y1="0" x2="0" y2="6" className="text-muted" stroke="currentColor" strokeWidth="2.5" opacity={0.5} />
          </pattern>
        </defs>

        {yTicks.map((t) => (
          <g key={t}>
            <line x1={padL} y1={baseY - h(t)} x2={W - padR} y2={baseY - h(t)}
              className="text-line" stroke="currentColor" strokeWidth={1} opacity={0.4} />
            <text x={padL - 8} y={baseY - h(t) + 3} textAnchor="end" className="text-muted fill-current text-[10px]">{money(t)}</text>
          </g>
        ))}

        {/* Legend — two bars need one, unlike the burn-up's end labels. */}
        <g>
          <rect x={padL} y={10} width={11} height={11} className="text-muted fill-current" opacity={0.32} />
          <text x={padL + 16} y={20} className="text-muted fill-current text-[10px]">{labels.sellable}</text>
          <rect x={padL + 128} y={10} width={11} height={11} className="text-ok fill-current" />
          <text x={padL + 144} y={20} className="text-muted fill-current text-[10px]">{labels.sold}</text>
        </g>

        {bars.map((b, i) => {
          const centre = cx(i);
          // ABSENT: the month label alone. Nothing that could be read as a measurement.
          if (b.absent) {
            return (
              <g key={b.key}>
                <text x={centre} y={baseY + 16} textAnchor="middle" className="text-muted fill-current text-[10px] opacity-50">{b.label}</text>
                <text x={centre} y={baseY + 30} textAnchor="middle" className="text-muted fill-current text-[8px] opacity-70">{labels.noData}</text>
              </g>
            );
          }
          const sellable = b.sellablePennies ?? 0;
          // The live month's sellable bar is drawn to the elapsed portion only.
          const shownSellable = b.live ? sellable * Math.max(0, Math.min(1, b.elapsedFraction)) : sellable;
          const backH = h(shownSellable), frontH = h(b.soldPennies);
          const pct = b.ratio === null ? null : `${(b.ratio * 100).toFixed(0)}%`;
          const pctY = Math.min(baseY - 6, baseY - Math.max(backH, frontH) - 7);
          return (
            <g key={b.key}>
              <title>
                {`${b.label} — ${labels.sellable} ${money(sellable)}, ${labels.sold} ${money(b.soldPennies)}`}
                {pct ? ` (${pct})` : ` — ${labels.noCapacity}`}{b.live ? ` · ${labels.partial}` : ''}
              </title>
              {/* SELLABLE — behind, lighter, wider. Hatched when the month is still running. */}
              {backH > 0 && (
                <rect x={centre - backW / 2} y={baseY - backH} width={backW} height={backH} rx={2}
                  {...(b.live
                    ? { fill: 'url(#cm-partial)' }
                    : { className: 'text-muted fill-current', opacity: 0.32 })} />
              )}
              {/* SOLD — in front, solid, same baseline, narrower so the remainder stays visible on
                  both shoulders rather than only above. */}
              {frontH > 0 && (
                <rect x={centre - frontW / 2} y={baseY - frontH} width={frontW} height={frontH} rx={2}
                  className={b.live && lit ? `${lit} fill-current` : 'text-ok fill-current'} />
              )}
              {/* NO CAPACITY: say so where the percentage would have gone. Unknown, not nought. */}
              {b.ratio === null && (
                <text x={centre} y={baseY - 6} textAnchor="middle" className="text-muted fill-current text-[8px]">—</text>
              )}
              {pct && (
                <text x={centre} y={pctY} textAnchor="middle"
                  className={`${b.live && lit ? lit : 'text-ink'} fill-current text-[10px] font-semibold`}>{pct}</text>
              )}
              <text x={centre} y={baseY + 16} textAnchor="middle"
                className={`${b.live ? 'text-ink font-semibold' : 'text-muted'} fill-current text-[10px]`}>{b.label}</text>
              {b.live && (
                <text x={centre} y={baseY + 30} textAnchor="middle" className="text-muted fill-current text-[8px]">{labels.partial}</text>
              )}
            </g>
          );
        })}
        <line x1={padL} y1={baseY} x2={W - padR} y2={baseY} className="text-line" stroke="currentColor" strokeWidth={1.5} />
      </svg>
    </div>
  );
}
