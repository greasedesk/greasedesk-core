/**
 * File: lib/status-colours.ts
 * THE chokepoint for the diary's job-STATUS colour bands (the traffic-light fill). Sibling of
 * lib/diary-colours (which owns the per-RESOURCE lift colour, now rendered as the block OUTLINE).
 *
 * One palette per TENANT (Group.status_colours JSON), admin-configurable in Settings → Locations &
 * Resources. Values are constrained to the curated RESOURCE_PALETTE — no free hex — so a fill can
 * never be white-on-white (unpickable by construction; the save API rejects anything off-palette).
 *
 * WARRANTY PRECEDENCE: a comeback (is_comeback) shows the warranty colour regardless of lifecycle —
 * a £0 goodwill job rendering as "complete, unpaid" would be misleading, and comebacks are the thing
 * an owner most wants visible on the board.
 *
 * Colour REINFORCES the status pill, never replaces it: red/green colour-blindness is ~1 in 12 men,
 * a meaningful share in this trade, so the label always stays and the palette is configurable.
 */
import { RESOURCE_PALETTE } from '@/lib/diary-colours';

export type StatusBand = 'not_started' | 'in_progress' | 'complete_unpaid' | 'paid' | 'warranty';

export const STATUS_BANDS: { key: StatusBand; label: string }[] = [
  { key: 'not_started', label: 'Not started' },
  { key: 'in_progress', label: 'In progress' },
  { key: 'complete_unpaid', label: 'Complete, unpaid' },
  { key: 'paid', label: 'Paid' },
  { key: 'warranty', label: 'Warranty / comeback' },
];

// Defaults — the traffic light plus a distinct violet for warranty. All drawn from RESOURCE_PALETTE.
export const DEFAULT_STATUS_COLOURS: Record<StatusBand, string> = {
  not_started: '#EF4444',      // red
  in_progress: '#F59E0B',      // amber
  complete_unpaid: '#3B82F6',  // blue
  paid: '#10B981',             // green
  warranty: '#8B5CF6',         // violet — distinct from the four traffic-light bands
};

/** Map a card's status (+ comeback flag) to its band. WARRANTY WINS over the lifecycle band. Cancelled
 *  and declined never reach here — they are excluded from the diary query (a cancelled job must not
 *  occupy a lift). `done` shares the paid band (terminal, money is in). */
export function statusBand(status: string, isComeback: boolean | null | undefined): StatusBand {
  if (isComeback) return 'warranty';
  switch (status) {
    case 'draft': case 'quoted': case 'accepted': return 'not_started';
    case 'in_progress': return 'in_progress';
    case 'invoiced': return 'complete_unpaid';
    case 'paid': case 'done': return 'paid';
    default: return 'not_started'; // any unexpected status defaults to the neutral-most band
  }
}

/** Merge a tenant's stored map over the defaults, keeping only valid on-palette hex values. */
export function resolveStatusColours(stored: unknown): Record<StatusBand, string> {
  const out = { ...DEFAULT_STATUS_COLOURS };
  if (stored && typeof stored === 'object') {
    for (const { key } of STATUS_BANDS) {
      const v = (stored as Record<string, unknown>)[key];
      if (typeof v === 'string' && (RESOURCE_PALETTE as readonly string[]).includes(v)) out[key] = v;
    }
  }
  return out;
}

/** The fill colour for a card, from the resolved tenant palette. */
export function bandColour(status: string, isComeback: boolean | null | undefined, colours: Record<StatusBand, string>): string {
  return colours[statusBand(status, isComeback)];
}

export const isStatusBand = (k: unknown): k is StatusBand => STATUS_BANDS.some((b) => b.key === k);
