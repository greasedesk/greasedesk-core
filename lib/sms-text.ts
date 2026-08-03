/**
 * File: lib/sms-text.ts
 * ONE transliteration, applied at the ONE point an SMS body is rendered (lib/notify).
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────────────────────────────
 * A single character outside the GSM 03.38 default alphabet drops the whole message from GSM-7
 * (160 chars/segment) to UCS-2 (70), so it can triple the segment count without changing a word.
 * The characters that do this are TYPOGRAPHIC, and the worst offender arrives in the tenant's own
 * garage name: "Dave’s Motors" and "Dave's Motors" look identical and read identically, but the
 * curly apostrophe costs three segments where the straight one costs one. A garage cannot be
 * expected to know that, and should not be billed for it.
 *
 * ── WHAT THIS IS NOT ────────────────────────────────────────────────────────────────────────────
 * It does NOT touch stored data — the tenant's name keeps whatever they typed, everywhere else.
 * It does NOT touch the email renderer, where UTF-8 is free and a proper apostrophe is nicer.
 * It is a CHANNEL concern, applied at the channel boundary, which is why it lives here and not in
 * the templates: a template author must not have to remember it.
 *
 * ── WHAT IS DELIBERATELY LEFT ALONE ─────────────────────────────────────────────────────────────
 * £ is at 0x01 of the GSM-7 DEFAULT alphabet — one septet, entirely safe, and must never be
 * mangled into "GBP". € is in the EXTENSION table: still GSM-7, but TWO septets. No template can
 * currently emit € (formatMoney is driven by the site's currency, and every live site is GBP), so
 * it is left as-is rather than transliterated — if a euro tenant ever arrives, the cost is two
 * septets, not a UCS-2 downgrade. Accented Latin (é, ü, à…) is in the default alphabet too.
 */

/** Typographic characters that force UCS-2, and the ASCII that reads the same in an SMS. */
const MAP: Array<[RegExp, string]> = [
  [/[‘’‚‛′]/g, "'"],   // ' ' ‚ ‛ ′  curly + prime → apostrophe
  [/[“”„‟″]/g, '"'],   // " " „ ‟ ″  curly doubles → quote
  [/[–—―]/g, '-'],               // – — ―      en/em/horizontal dash → hyphen
  [/…/g, '...'],                            // …          ellipsis
  [/[    ]/g, ' '],          //            non-breaking / thin spaces
  [/[•·]/g, '-'],                      // • ·        bullets
  [/[‹›]/g, "'"],                      // ‹ ›
  [/[«»]/g, '"'],                      // « »
  [/‐|‑/g, '-'],                       // ‐ ‑        hyphen variants
  [/™/g, '(TM)'],                           // ™
  [/®/g, '(R)'],                            // ®
  [/⁄/g, '/'],                              // ⁄
];

/** Fold the typography that would force UCS-2. Everything else is passed through untouched. */
export function smsText(input: string): string {
  let out = String(input ?? '');
  for (const [re, to] of MAP) out = out.replace(re, to);
  return out;
}
