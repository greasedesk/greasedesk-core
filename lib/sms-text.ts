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

/**
 * ── SEGMENT COUNTING (2026-08-08) ───────────────────────────────────────────────────────────────
 * There was none. The magic-link token was sized by hand against a segment budget and the templates
 * were written to "about 160 characters" by eye — which held only while nothing was added to them.
 * Adding the garage's phone number to every customer-facing SMS is exactly the change that breaks a
 * budget nobody measures, so the budget is now measurable.
 *
 * GSM-7 packs 160 septets into one segment, 153 when a message is split (the UDH header eats 7).
 * Characters in the GSM 03.38 EXTENSION table (including the euro, and [ ] { } \ ~ ^ |) cost TWO
 * septets each. Anything outside the alphabet forces the WHOLE message to UCS-2: 70 characters, 67
 * when concatenated. Run smsText() first — that is what keeps typography from triggering the cliff.
 */
const GSM_BASE =
  '@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?'
  + '¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà';
const GSM_EXTENDED = '^{}\\[~]|€';

export type SmsCost = { encoding: 'GSM-7' | 'UCS-2'; septets: number; segments: number };

export function smsCost(text: string): SmsCost {
  const chars = Array.from(text);
  let septets = 0;
  for (const c of chars) {
    if (GSM_EXTENDED.includes(c)) { septets += 2; continue; }
    if (GSM_BASE.includes(c)) { septets += 1; continue; }
    // One character outside the alphabet drops the entire message to UCS-2 — there is no partial.
    const units = chars.reduce((n, ch) => n + (ch.codePointAt(0)! > 0xffff ? 2 : 1), 0);
    return { encoding: 'UCS-2', septets: units, segments: units <= 70 ? 1 : Math.ceil(units / 67) };
  }
  return { encoding: 'GSM-7', septets, segments: septets <= 160 ? 1 : Math.ceil(septets / 153) };
}

/** One segment? The assertion a template test should make, rather than counting characters by eye. */
export const isOneSegment = (text: string): boolean => smsCost(text).segments <= 1;
