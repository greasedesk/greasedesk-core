/**
 * File: lib/diary-colours.ts
 * Single source for the curated resource (lift) colour palette used by the diary and the
 * Settings colour picker, plus helpers. Colours are chosen to read well on a white calendar.
 */

export const RESOURCE_PALETTE = [
  '#3B82F6', // blue
  '#10B981', // green
  '#F59E0B', // amber
  '#EF4444', // red
  '#8B5CF6', // violet
  '#EC4899', // pink
  '#14B8A6', // teal
  '#F97316', // orange
  '#6366F1', // indigo
  '#84CC16', // lime
] as const;

// Neutral fallback when a resource has no colour set.
export const DEFAULT_RESOURCE_COLOUR = '#64748B'; // slate

export function isValidPaletteColour(c: unknown): c is string {
  return typeof c === 'string' && (RESOURCE_PALETTE as readonly string[]).includes(c);
}

export function resolveColour(c: string | null | undefined): string {
  return c && (RESOURCE_PALETTE as readonly string[]).includes(c) ? c : DEFAULT_RESOURCE_COLOUR;
}

// Pale tint of a hex colour for the block background (≈13% alpha over white).
export function blockTint(hex: string): string {
  return `${hex}22`;
}

/**
 * THE GHOST — a no-show block on the board. FIXED, deliberately outside the tenant-curated status
 * palette: that palette is for live work states a garage may re-colour, and "this didn't happen"
 * must not be re-colourable into looking live. One grey, everywhere a ghost renders.
 */
export const GHOST_COLOUR = '#94A3B8'; // slate-400
export const GHOST_FILL = '#94A3B81F'; // ~12% alpha — paler than any live tint

/**
 * ── STOCK: A CAR WE OWN ─────────────────────────────────────────────────────────────────────────
 *
 * FIXED, and outside Group.status_colours for the same reason the ghost is: the tenant palette is for
 * live work states a garage may re-colour, and "this one is ours" must not be reconfigurable into
 * something that stops matching the orange sticker on the windscreen. One signal on the glass and one
 * on the board, and neither drifts from the other through a settings screen.
 *
 * NOT A STATUS BAND. A band is a lifecycle position; this is a statement about whose car it is, which
 * is why it takes precedence over the lifecycle exactly as the warranty band does — and why it lives
 * here rather than in the configurable map.
 *
 * ── WHY SOLID, AND NOT SIMPLY ANOTHER HUE ───────────────────────────────────────────────────────
 *
 * Orange (#F97316) is free in RESOURCE_PALETTE, but amber (#F59E0B) is already the in-progress FILL
 * *and* Lift 1's OUTLINE on the tenant this was designed for — three amber-ish things on one board,
 * and at wall-screen distance hue alone will not separate them.
 *
 * So the distinction is carried by LIGHTNESS AND SATURATION, not hue: every other block is a ~13%
 * tint with coloured text, and a stock block is SOLID with white text. That is the one visual channel
 * nothing else on the board uses, and it reads from across a workshop without reading the legend —
 * which was the requirement. The 2px lift border stays: it still separates against a solid ground.
 */
export const STOCK_COLOUR = '#F97316'; // orange — matches the physical window stickers
export const STOCK_FILL = '#F97316';   // SOLID, deliberately: see above. Not a tint.
export const STOCK_TEXT = '#FFFFFF';   // white on solid orange — the only white-on-fill block there is
