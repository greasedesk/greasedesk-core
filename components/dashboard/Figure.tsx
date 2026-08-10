/**
 * File: components/dashboard/Figure.tsx
 * ONE RULE FOR EVERY NUMBER ON THE DASHBOARD: shrink to fit, and only when it does not fit.
 *
 * ── WHY NOT A SMALLER BASE SIZE ─────────────────────────────────────────────────────────────────
 * The tiles were sized for monthly figures and a twelve-month selection is an order of magnitude
 * larger — £259,350.55 needs 193px in a 161px box. Dropping the base size everywhere would fix the
 * year by making the month worse, permanently, for every tenant who never leaves the month view.
 * A garage reading its month at arm's length across a workshop is the common case and it should
 * keep the biggest type the card can hold.
 *
 * ── WHY NOT PER-TILE TWEAKS ─────────────────────────────────────────────────────────────────────
 * Because the next tile, or the next currency, or a tenant whose numbers are simply bigger, breaks
 * again somewhere nobody checked. The rule is a property of "a number in a box", not of any tile.
 *
 * ── HOW ─────────────────────────────────────────────────────────────────────────────────────────
 * Measured, not guessed: the element is nowrap and clipped, so scrollWidth is the natural width of
 * the text and clientWidth is the room available. If it already fits, NOTHING is touched — the
 * font-size is left to the Tailwind class, so a monthly dashboard renders byte-identically to
 * before. If it does not, the size is scaled by exactly the ratio needed, with a floor so a
 * pathological value degrades to small-but-legible rather than to a smear.
 *
 * Re-measured on resize (the grid reflows at breakpoints) and whenever the value changes, both of
 * which is what a ResizeObserver on the element plus a value-keyed effect gives us. Measurement
 * happens in useLayoutEffect, before paint, so nothing is ever seen overflowing first.
 */
import React, { useCallback, useEffect, useLayoutEffect, useRef } from 'react';

type Props = {
  children: React.ReactNode;
  /** Tailwind classes, including the BASE size (text-3xl / text-lg …). Unchanged when it fits. */
  className?: string;
  /** Never shrink past this fraction of the base — below it, the number stops being readable and
   *  the honest answer is a smaller figure, not a tinier one. */
  minScale?: number;
  title?: string;
  'data-testid'?: string;
};

export default function Figure({ children, className = '', minScale = 0.6, title, ...rest }: Props) {
  const ref = useRef<HTMLSpanElement>(null);

  const fit = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    // Back to the class's own size before measuring, or each pass would compound the last one's
    // shrink and the number would creep smaller on every resize.
    el.style.fontSize = '';
    const natural = el.scrollWidth;
    const available = el.clientWidth;
    if (!available || natural <= available + 1) return; // fits → leave the class alone entirely
    const base = parseFloat(window.getComputedStyle(el).fontSize) || 16;
    // Text width is NOT perfectly linear in font-size — letter-spacing, hinting and sub-pixel
    // rounding all take a cut — so a single ratio lands a few pixels long. Measured on the served
    // page: £259,350.55 went 193px → 133px in a 129px box, still clipped. So: a small margin, then
    // re-measure and correct, at most three passes. Converges in one or two in practice.
    let size = base * Math.max(minScale, (available / natural) * 0.985);
    for (let pass = 0; pass < 3; pass++) {
      el.style.fontSize = `${size.toFixed(2)}px`;
      if (el.scrollWidth <= el.clientWidth + 1) return;
      const floor = base * minScale;
      if (size <= floor + 0.01) return;   // at the floor: small-but-legible beats a smear
      size = Math.max(floor, size * Math.max(0.8, (el.clientWidth / el.scrollWidth) * 0.99));
    }
  }, [minScale]);

  useLayoutEffect(fit);

  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => fit());
    ro.observe(el);
    return () => ro.disconnect();
  }, [fit]);

  return (
    <span
      ref={ref}
      title={title}
      // min-w-0 lets it shrink inside a flex row instead of pushing the label off; overflow-hidden
      // is what makes scrollWidth mean "natural width" rather than "whatever fitted".
      //
      // basis-0 grow (flex-1) matters more than it looks: as a CONTENT-SIZED flex item, the width
      // this measures against changes when the font-size does, so resetting to base to take a clean
      // reading also handed it more room, it reported "fits", and it settled back overflowing —
      // measured on the served page as a stubborn 133px in a 129px box that no number of passes
      // fixed. With a zero basis the width comes from the ROW, so scrollWidth is honestly the
      // content and clientWidth is honestly the space. Ignored outside a flex parent, so the
      // block-level tiles are unaffected.
      className={`block min-w-0 flex-1 overflow-hidden whitespace-nowrap ${className}`}
      {...rest}
    >
      {children}
    </span>
  );
}
