/**
 * File: components/quotes/ConversionChart.tsx
 * Quoted value vs accepted value, COHORT-bucketed by send date. Pure inline SVG, theme-safe via
 * semantic tokens — no chart dependency, same approach as CapacityChart.
 *
 * Returns null on an empty series. The PAGE must still guard before its wrapper: the last two
 * slices both found a block drawing its shell, heading and axes around absent data, which reads as
 * "we measured and found nothing" rather than "there is nothing to measure".
 *
 * An INCOMPLETE bucket is hatched rather than dropped: quotes sent inside the expiry window have
 * not had their chance to be answered, so their acceptance bar is genuinely partial. Hiding the
 * bucket would understate activity; showing it plain would understate conversion.
 */
import React from 'react';

export type ConversionPoint = { key: string; label: string; quotedPennies: number; acceptedPennies: number; incomplete: boolean };

type Props = {
  series: ConversionPoint[];
  money: (pennies: number) => string;
  labels: { quoted: string; accepted: string; incomplete: string };
};

const W = 720, H = 240, padL = 56, padR = 16, padT = 12, padB = 40;
const plotW = W - padL - padR, plotH = H - padT - padB;

export default function ConversionChart({ series, money, labels }: Props) {
  if (!series.length) return null;
  const max = Math.max(...series.map((p) => Math.max(p.quotedPennies, p.acceptedPennies)), 1);
  const top = Math.ceil(max / 1000) * 1000 || 1;
  const n = series.length;
  const slot = plotW / n;
  const barW = Math.max(4, Math.min(28, slot * 0.34));
  const y = (v: number) => padT + plotH - (v / top) * plotH;
  // Label every bucket when there is room, otherwise roughly six.
  const step = Math.max(1, Math.ceil(n / 8));

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-auto" role="img" aria-label={`${labels.quoted} / ${labels.accepted}`}>
      <defs>
        <pattern id="gd-incomplete" patternUnits="userSpaceOnUse" width="5" height="5" patternTransform="rotate(45)">
          <line x1="0" y1="0" x2="0" y2="5" stroke="currentColor" strokeWidth="2" opacity="0.35" />
        </pattern>
      </defs>
      {[0, 0.5, 1].map((f) => (
        <g key={f}>
          <line x1={padL} x2={padL + plotW} y1={y(top * f)} y2={y(top * f)} className="text-line" stroke="currentColor" strokeWidth="1" />
          <text x={padL - 8} y={y(top * f) + 4} textAnchor="end" className="fill-muted" fontSize="11">{money(Math.round(top * f))}</text>
        </g>
      ))}
      {series.map((p, i) => {
        const cx = padL + i * slot + slot / 2;
        return (
          <g key={p.key}>
            <rect x={cx - barW - 1} y={y(p.quotedPennies)} width={barW} height={Math.max(0, padT + plotH - y(p.quotedPennies))}
              className="text-muted" fill="currentColor" opacity="0.35" />
            <rect x={cx + 1} y={y(p.acceptedPennies)} width={barW} height={Math.max(0, padT + plotH - y(p.acceptedPennies))}
              className="text-ok" fill="currentColor" />
            {p.incomplete && (
              <rect x={cx - barW - 1} y={padT} width={barW * 2 + 2} height={plotH} className="text-muted" fill="url(#gd-incomplete)" />
            )}
            {i % step === 0 && (
              <text x={cx} y={H - 22} textAnchor="middle" className="fill-muted" fontSize="10">{p.label}</text>
            )}
          </g>
        );
      })}
      <g transform={`translate(${padL}, ${H - 8})`} fontSize="11">
        <rect x="0" y="-9" width="10" height="10" className="text-muted" fill="currentColor" opacity="0.35" />
        <text x="15" y="0" className="fill-muted">{labels.quoted}</text>
        <rect x="90" y="-9" width="10" height="10" className="text-ok" fill="currentColor" />
        <text x="105" y="0" className="fill-muted">{labels.accepted}</text>
        {series.some((p) => p.incomplete) && (
          <>
            <rect x="200" y="-9" width="10" height="10" className="text-muted" fill="url(#gd-incomplete)" />
            <text x="215" y="0" className="fill-muted">{labels.incomplete}</text>
          </>
        )}
      </g>
    </svg>
  );
}
