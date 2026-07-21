/**
 * File: lib/consent.ts
 * THE cookie-consent core — isomorphic (no React, no DB), so the server (SSR read) and client (banner,
 * gd_ref gate) share one definition of what consent is. Categories, the consent cookie, encode/decode,
 * and the ONE gated writer (gd_ref) live here. lib/consent-config carries the per-region copy/defaults.
 *
 * DISCIPLINE: consent GATES loading, not just setting. Nothing non-necessary fires until its category
 * is consented. A future tracker (GA, a pixel) registers with the ConsentProvider under its category and
 * is injected only on consent — so adding tracker N+1 is a config line, not a compliance rebuild.
 */
export const CONSENT_COOKIE = 'gd_consent'; // strictly-necessary, consent-exempt (stores the choice)
export const CONSENT_MAX_AGE_DAYS = 180;    // ICO: re-ask periodically; 6 months is a common cadence

/** Bump when the categories or their meaning change — old consents then re-prompt (version mismatch). */
export const POLICY_VERSION = '2026-07-21';

export type ConsentCategory = 'functional' | 'analytics' | 'marketing'; // 'necessary' is implicit, always on
export const CONSENTABLE: ConsentCategory[] = ['functional', 'analytics', 'marketing'];

export type ConsentChoice = { functional: boolean; analytics: boolean; marketing: boolean };
export type ConsentRecord = { v: string; id: string; ts: number; region: string; choice: ConsentChoice };

export const ALL_ON: ConsentChoice = { functional: true, analytics: true, marketing: true };
export const ALL_OFF: ConsentChoice = { functional: false, analytics: false, marketing: false };

/** A record is "current" only if it exists AND its policy version matches — a bumped policy re-prompts. */
export function isCurrent(rec: ConsentRecord | null | undefined): rec is ConsentRecord {
  return !!rec && rec.v === POLICY_VERSION;
}

export function encodeConsent(rec: ConsentRecord): string {
  return encodeURIComponent(JSON.stringify(rec));
}
export function decodeConsent(raw: string | undefined | null): ConsentRecord | null {
  if (!raw) return null;
  try {
    const o = JSON.parse(decodeURIComponent(raw));
    if (!o || typeof o !== 'object' || !o.choice) return null;
    return {
      v: String(o.v ?? ''), id: String(o.id ?? ''), ts: Number(o.ts ?? 0), region: String(o.region ?? ''),
      choice: { functional: !!o.choice.functional, analytics: !!o.choice.analytics, marketing: !!o.choice.marketing },
    };
  } catch { return null; }
}

/** Server-side: pull the consent record out of a raw Cookie header (SSR, so the banner never flashes). */
export function parseConsentCookie(cookieHeader: string | undefined | null): ConsentRecord | null {
  if (!cookieHeader) return null;
  const m = cookieHeader.match(new RegExp('(?:^|;\\s*)' + CONSENT_COOKIE + '=([^;]+)'));
  return m ? decodeConsent(m[1]) : null;
}

/** Client-side: persist the choice in the (exempt) consent cookie. Secure + SameSite=Lax, host-only. */
export function writeConsentCookie(rec: ConsentRecord): void {
  if (typeof document === 'undefined') return;
  const maxAge = CONSENT_MAX_AGE_DAYS * 24 * 60 * 60;
  document.cookie = `${CONSENT_COOKIE}=${encodeConsent(rec)}; path=/; max-age=${maxAge}; SameSite=Lax; Secure`;
}

// ── The ONE consent-gated first-party writer today: gd_ref (functional / referral attribution). ──
export const GD_REF_COOKIE = 'gd_ref';
export const GD_REF_MAX_AGE_DAYS = 90;
/** Sanitise a raw ?ref= value the same way capture always has (alnum . _ - only, capped 64). */
export function sanitiseRef(raw: unknown): string {
  const s = (Array.isArray(raw) ? raw[0] : raw);
  return (typeof s === 'string' ? s : '').trim().replace(/[^a-zA-Z0-9._-]/g, '').slice(0, 64);
}
/** Write gd_ref. Callers MUST have checked functional consent first — this is the sink, not the gate. */
export function writeGdRef(clean: string): void {
  if (typeof document === 'undefined' || !clean) return;
  const maxAge = GD_REF_MAX_AGE_DAYS * 24 * 60 * 60;
  document.cookie = `${GD_REF_COOKIE}=${encodeURIComponent(clean)}; path=/; max-age=${maxAge}; SameSite=Lax; Secure`;
}
/** Remove gd_ref (e.g. functional consent withdrawn) — set it expired. */
export function clearGdRef(): void {
  if (typeof document === 'undefined') return;
  document.cookie = `${GD_REF_COOKIE}=; path=/; max-age=0; SameSite=Lax; Secure`;
}
