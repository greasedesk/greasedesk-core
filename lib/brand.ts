/**
 * File: lib/brand.ts
 * THE single source for GreaseDesk's brand voice — the strapline and subline. The marketing header,
 * footer and page metadata all read from here, so the promise reads identically everywhere and a
 * wording change happens in exactly one place. No other copy belongs here.
 */
export const STRAPLINE = 'Know what you kept.';
export const SUBLINE = 'Manage your profit, not just your diary.';

/**
 * The homepage <title>/og:title/twitter:title. Derived from STRAPLINE (so it can't drift) but with
 * the terminal full stop dropped — titles don't take sentence punctuation.
 */
export const PAGE_TITLE = `GreaseDesk — ${STRAPLINE.replace(/\.$/, '')}`;
