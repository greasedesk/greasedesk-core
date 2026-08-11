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

/**
 * ── BRAND SUFFIX FOR CONTENT-DRIVEN PAGES ───────────────────────────────────────────────────────
 * A document created in the Engine Room gets a URL with no deploy, so it also gets its <title> with
 * no deploy — and that title was `Document.title` verbatim: `/cookies` served a bare "Cookie
 * policy". Every hand-built page carries the brand ("Pricing — GreaseDesk garage management
 * software"), so the content pages were the only ones that did not.
 *
 * The composition lives HERE and not in components/marketing/Seo, whose contract is "a finished
 * title, page-specific". Suffixing inside Seo would turn "Contact GreaseDesk — talk to us" into
 * "Contact GreaseDesk — talk to us — GreaseDesk"; those pages place the brand mid-sentence on
 * purpose. And it does not live in Document.title, because that value is ALSO the on-page <h1>,
 * which must stay bare — and because editing rows does not cover the next document.
 */
export const brandTitle = (name: string): string => `${name.trim()} — GreaseDesk`;

/**
 * The meta description for a content-driven page.
 *
 * ── WHY THIS IS A FORMULA AND NOT THE DOCUMENT'S OWN OPENING ────────────────────────────────────
 * Deriving it from the body was the obvious idea and it was tested against the real documents
 * before being rejected. Legal documents open with front-matter and a table of contents, not a
 * summary, so the first 155 characters gave: "Version: 2.0 · Effective: 9 August 2026 --- 1. Who we
 * are and what these terms cover 2. Definitions 3." for /terms, the contents list for /privacy,
 * and — worst — "Draft — legal wording pending review … the surrounding legal sections are
 * placeholders" for /cookies, which would have published a draft notice into a search snippet.
 *
 * A formula is duller and cannot embarrass us. It varies by title, so the three pages do not share
 * one duplicate description, and the next document is covered without anybody remembering to write
 * one. If a page ever deserves better wording than this, that is the point to add a per-document
 * field — not before.
 */
export const brandDescription = (name: string): string =>
  `${name.trim()} for GreaseDesk — garage management software for independent workshops.`;
