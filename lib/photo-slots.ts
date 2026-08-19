/**
 * File: lib/photo-slots.ts
 * WHICH PHOTO SLOTS BELONG TO A SECTION OF THEIR OWN — one positive answer, one place.
 *
 * ── WHY THIS FILE EXISTS ────────────────────────────────────────────────────────────────────────
 * The customer report shows tyre photos beside their corner and battery photos beside the test
 * result, so those must NOT also appear in the general photo grid. The first version of that rule
 * was written as a negative test naming one section — `!cornerFromSlot(m.slot)` — which was correct
 * on the day and silently wrong the moment a second section existed: battery photos would have
 * appeared twice, once in their block and once in the general pile.
 *
 * A negative filter that names one section has to be edited every time a section is added, and the
 * failure when it isn't is a duplicate rather than an error — nothing throws, the page just looks
 * slightly wrong. So the question is asked positively and answered here: is this slot claimed by a
 * section that renders it itself? A new section registers below and every reader is correct at once.
 */
import { tyreSlot, type TyreCorner } from '@/lib/tyres';
import { BATTERY_SLOTS } from '@/lib/battery';

const TYRE_CORNERS: TyreCorner[] = ['front_left', 'front_right', 'rear_left', 'rear_right'];

/**
 * Every slot rendered by a section of its own. Add a section's slots here and the general grid
 * stops double-showing them everywhere at once.
 *
 * NOT included, deliberately: 'vin', 'damage', 'freeform', 'walkaround', 'diag_scan'. Those are
 * either the general grid itself or a video, and they belong in the pile.
 */
export const SECTION_OWNED_SLOTS: ReadonlySet<string> = new Set<string>([
  ...TYRE_CORNERS.map(tyreSlot),
  ...BATTERY_SLOTS,
]);

/** True when a section renders this photo itself, so the general grid must skip it. */
export const slotOwnedBySection = (slot: string | null | undefined): boolean =>
  slot != null && SECTION_OWNED_SLOTS.has(slot);
