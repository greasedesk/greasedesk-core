/**
 * File: lib/brand.ts
 * THE single source for GreaseDesk's brand voice — the strapline and subline. The marketing header,
 * footer and page metadata all read from here, so the promise reads identically everywhere and a
 * wording change happens in exactly one place. No other copy belongs here.
 */
export const STRAPLINE = 'Paydirt';
export const SUBLINE = 'Manage your profit, not just your diary.';

/**
 * The homepage <title>/og:title/twitter:title. A literal, DECOUPLED from STRAPLINE by design
 * (rulings 2026-07-28): the strapline is 'Paydirt'; the title carries the category positioning.
 */
export const PAGE_TITLE = 'GreaseDesk — Workshop Economics';
