/**
 * File: lib/contact-routes.ts
 * THE one resolver of a garage's customer-facing contact routes. Phone and WhatsApp each fall back
 * site → group INDEPENDENTLY — a garage may have a landline at the site and WhatsApp only at company
 * level, or WhatsApp on a completely different number, or neither. Resolving them through one
 * function is what stops the two chains drifting apart as more surfaces (portal, reminders, SMS)
 * start needing "how do I reach this garage?".
 *
 * ── E.164 NORMALISATION (decision: ACCEPT UK-LOCAL AND CONVERT) ─────────────────────────────────
 * wa.me requires bare international digits — no +, no spaces, no leading zero. Asking a garage to
 * type "447700900123" invites silent mistakes, so we accept what they'd actually write:
 *     07700 900123     → 447700900123   (UK local: drop the trunk 0, prefix 44)
 *     0330 999 0020    → 443309990020
 *     +44 7700 900123  → 447700900123
 *     00447700900123   → 447700900123
 *     447700900123     → 447700900123   (already E.164)
 * A non-UK number MUST be given in international form (+…/00…) — we never guess a country for a
 * bare local number that isn't UK-shaped. Unparseable input returns null so a bad value is stored
 * as "not set" rather than producing a broken wa.me link.
 *
 * DEFAULT_COUNTRY is UK because that is the entire current market; it is the one line to revisit
 * when a non-GB tenant lands (see the locale-profiles precedent).
 */
const DEFAULT_CC = '44';

/** Digits-only E.164 (no +) suitable for a wa.me URL, or null when it cannot be resolved. */
export function toE164Digits(raw: string | null | undefined, defaultCc = DEFAULT_CC): string | null {
  if (!raw) return null;
  const trimmed = String(raw).trim();
  if (!trimmed) return null;
  // Keep a leading + as an explicit international marker, then reduce to digits.
  const isPlus = trimmed.startsWith('+');
  let d = trimmed.replace(/\D/g, '');
  if (!d) return null;

  if (isPlus) return d.length >= 8 ? d : null;          // +44 7700 900123 → 447700900123
  if (d.startsWith('00')) { d = d.slice(2); return d.length >= 8 ? d : null; } // 0044… → 44…
  if (d.startsWith('0')) return defaultCc + d.slice(1); // UK local: trunk 0 → country code
  if (d.startsWith(defaultCc)) return d;                // already E.164-ish
  // A bare number that is neither trunk-prefixed nor country-prefixed: too ambiguous to guess.
  return d.length >= 11 ? d : null;
}

/** The wa.me URL for a stored number, or null. */
export function whatsappUrl(stored: string | null | undefined): string | null {
  const e164 = toE164Digits(stored);
  return e164 ? `https://wa.me/${e164}` : null;
}

/** tel: href for a phone, spaces stripped (kept human-readable for display separately). */
export function telHref(phone: string | null | undefined): string | null {
  if (!phone?.trim()) return null;
  return `tel:${phone.replace(/[^\d+]/g, '')}`;
}

export type ContactRoutes = {
  /** Friendly, as the garage typed it — what a human reads. */
  phone: string | null;
  phoneHref: string | null;
  /** Friendly WhatsApp number for display. */
  whatsapp: string | null;
  /** The wa.me link (E.164 digits). Null when no usable number. */
  whatsappUrl: string | null;
  /** TRUE only when NEITHER route exists — the setup gap the customer page must flag out loud. */
  setupGap: boolean;
};

/**
 * Resolve both routes with the site → group fallback applied to each independently.
 * Pass the site's and the group's stored values; either side may be null.
 */
export function resolveContactRoutes(
  site: { phone?: string | null; whatsapp?: string | null } | null | undefined,
  group: { phone?: string | null; whatsapp?: string | null } | null | undefined,
): ContactRoutes {
  const phone = (site?.phone?.trim() || group?.phone?.trim() || null);
  const wa = (site?.whatsapp?.trim() || group?.whatsapp?.trim() || null);
  const waUrl = whatsappUrl(wa);
  return {
    phone,
    phoneHref: telHref(phone),
    whatsapp: wa,
    whatsappUrl: waUrl,
    // A WhatsApp number that cannot be normalised is NOT a route — it would render a dead link.
    setupGap: !phone && !waUrl,
  };
}
