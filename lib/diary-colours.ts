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
