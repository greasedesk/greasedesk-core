/**
 * File: lib/reporting-anchor.ts
 * WHERE A TENANT'S REPORTING BEGINS, AND THE ONE PLACE A WINDOW IS CLIPPED TO IT.
 *
 * ── WHY THIS IS ONE FUNCTION AND NOT A HABIT ────────────────────────────────────────────────────
 * Clipping was previously opt-in per dashboard tile: costBase, utilisation and capacity each called
 * clipToData, and pnl, manpower, missingHours and the cash tiles did not. Nothing made that
 * visible, so net profit measured TWELVE months of payroll against FIVE months of trading and sat
 * beside a five-month cost base:
 *
 *     Net profit  −£58,043.76        Fixed costs  £35,875.05
 *
 * Neither is wrong on its own. On TMBS the same data reads −£58,043.76 anchored at September 2025
 * and +£18,181.35 anchored at April 2026 — the frame decides, so the frame must be explicit, owned
 * by the garage, and applied to everything at once.
 *
 * Applied where the tile context is built, BEFORE any compute runs. That makes clipping opt-OUT: a
 * new tile is clipped by default, and a tile that should not be has to say so in writing.
 */

export type AnchoredWindow = {
  from: Date;
  to: Date;
  /** Whole months in the CLIPPED window — never the caller's original count. */
  months: number;
  /** The selection began before the anchor and its start was moved forward. */
  clipped: boolean;
  /** The selection ended before the anchor: nothing here was ever reported on. */
  empty: boolean;
};

const MS_PER_AVERAGE_MONTH = 86_400_000 * 30.436875;

/**
 * Clip a window to the tenant's reporting anchor.
 *
 * ── MONTHS MOVES WITH THE WINDOW ────────────────────────────────────────────────────────────────
 * The trap one layer down, and the reason this returns `months` rather than leaving it to the
 * caller: cost is a monthly rate × months, so clipping `from` without recomputing the count bills
 * twelve months of payroll against a five-month window. The window looks right while the total is
 * 2.4× too big — harder to spot than the bug it replaces.
 *
 * ── EMPTY IS NOT ZERO ───────────────────────────────────────────────────────────────────────────
 * A selection ending before the anchor has no figure at all. Zeros read as findings: "£0.00
 * revenue" is a claim about a month that traded badly, not about a month nobody reported on.
 */
export function clipSpanToAnchor(from: Date, to: Date, anchor: Date): AnchoredWindow {
  if (to.getTime() <= anchor.getTime()) return { from, to, months: 0, clipped: false, empty: true };
  if (from.getTime() >= anchor.getTime()) {
    return { from, to, months: monthsBetween(from, to), clipped: false, empty: false };
  }
  return { from: anchor, to, months: monthsBetween(anchor, to), clipped: true, empty: false };
}

/** Whole months, rounded — the same arithmetic the tile computes used before it moved here. */
export function monthsBetween(from: Date, to: Date): number {
  return Math.max(1, Math.round((to.getTime() - from.getTime()) / MS_PER_AVERAGE_MONTH));
}

/**
 * The anchor as a month string for display — "September 2025", never a day. The stored value is
 * always the first of a month (the backfill truncates and the writer normalises), so a day would
 * be noise pretending to be precision.
 */
export function anchorMonthLabel(anchor: Date, locale: string): string {
  return anchor.toLocaleDateString(locale, { month: 'long', year: 'numeric', timeZone: 'UTC' });
}

/** Normalise a chosen date to the first of its month, in UTC. The one writer path uses this. */
export function normaliseAnchor(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
}
