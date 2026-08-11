/**
 * File: lib/brand.ts
 * THE single source for GreaseDesk's brand voice — the strapline and subline. The marketing header,
 * footer and page metadata all read from here, so the promise reads identically everywhere and a
 * wording change happens in exactly one place. No other copy belongs here.
 */
/**
 * ── THE ≠ IS A REAL CHARACTER, NOT A LIGATURE OR AN IMAGE ───────────────────────────────────────
 * U+2260 NOT EQUAL TO. It stays a text character so it inherits the weight, colour and size of the
 * lockup, stays selectable and searchable, and reads to a screen reader as "not equal to" rather
 * than as nothing. Verified before shipping (2026-08-10) by drawing it to a canvas and comparing
 * the pixels against '=' and against a private-use codepoint no font can have: distinct, non-empty
 * glyph in every family the site actually resolves to. There is NO webfont on this site — the stack
 * is system fonts only — so there is no brand font to fail to load.
 */
export const STRAPLINE = 'Busy ≠ Profitable';
export const SUBLINE = 'Manage your profit, not just your diary.';

/**
 * The homepage <title>/og:title/twitter:title. A literal, DECOUPLED from STRAPLINE by design
 * (rulings 2026-07-28): the strapline is its own line; the title carries the category positioning.
 */
export const PAGE_TITLE = 'GreaseDesk — Workshop Economics';
