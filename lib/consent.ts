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

// ── COOKIE SCOPE: THE REGISTRABLE DOMAIN, NOT THE HOST ───────────────────────────────────────────
// Both cookies below are scoped to `.greasedesk.com` so they hold ACROSS SUBDOMAINS. Host-only was
// right while there was one public host; it stopped being right the moment affiliates got their own.
// A consent given on greasedesk.com must still be a consent on affiliates.greasedesk.com — asking
// the same visitor twice is worse than not asking — and a referral cookie set by an affiliate link
// has to survive the walk to the apex signup page, which is the whole point of the link.
//
// Anything that is not greasedesk.com gets NO domain attribute, which leaves the cookie host-only:
// localhost, *.vercel.app previews and the .test hosts cannot be given a parent domain anyway, and
// a wrong `domain=` is silently dropped by the browser rather than reported.
export const COOKIE_DOMAIN = '.greasedesk.com';

/** The domain attribute for a host, or '' when the host cannot carry one. Exported so it is testable. */
export function cookieDomainFor(host: string | null | undefined): string {
  const h = (host ?? '').toLowerCase().split(':')[0].replace(/\.$/, '');
  if (!h) return '';
  return h === 'greasedesk.com' || h.endsWith('.greasedesk.com') ? COOKIE_DOMAIN : '';
}

const currentDomain = () => cookieDomainFor(typeof location !== 'undefined' ? location.hostname : '');

/**
 * Write a cookie at the widest scope this host allows.
 *
 * A HOST-ONLY COOKIE OF THE SAME NAME SURVIVES A DOMAIN-SCOPED WRITE. The browser keeps both, and
 * `document.cookie` returns both as `name=a; name=b` with no attributes and no defined order — so a
 * reader cannot tell which it has. Every visitor already holding the old host-only gd_ref or
 * gd_consent would be in exactly that state the first time this widened write ran. Widening a
 * cookie's scope therefore means EXPIRING THE NARROW ONE FIRST, not just setting the wide one.
 */
function setCookie(name: string, value: string, maxAgeDays: number): void {
  if (typeof document === 'undefined') return;
  const domain = currentDomain();
  if (domain) document.cookie = `${name}=; path=/; max-age=0; SameSite=Lax; Secure`; // the host-only predecessor
  document.cookie = `${name}=${value}; path=/; max-age=${maxAgeDays * 24 * 60 * 60}`
    + `${domain ? `; domain=${domain}` : ''}; SameSite=Lax; Secure`;
}

/** Expire a cookie at BOTH scopes — a withdrawal that leaves either copy standing has withdrawn nothing. */
function expireCookie(name: string): void {
  if (typeof document === 'undefined') return;
  const domain = currentDomain();
  document.cookie = `${name}=; path=/; max-age=0; SameSite=Lax; Secure`;
  if (domain) document.cookie = `${name}=; path=/; max-age=0; domain=${domain}; SameSite=Lax; Secure`;
}

/** Read one cookie from document.cookie, or null. Shared so every reader agrees on the name. */
export function readCookie(name: string): string | null {
  if (typeof document === 'undefined') return null;
  const m = document.cookie.match(new RegExp('(?:^|;\\s*)' + name + '=([^;]*)'));
  return m && m[1] ? decodeURIComponent(m[1]) : null;
}

/** Client-side: persist the choice in the (exempt) consent cookie, scoped to the registrable domain. */
export function writeConsentCookie(rec: ConsentRecord): void {
  setCookie(CONSENT_COOKIE, encodeConsent(rec), CONSENT_MAX_AGE_DAYS);
}

// ── The ONE consent-gated first-party writer today: gd_ref (functional / referral attribution). ──
export const GD_REF_COOKIE = 'gd_ref';
export const GD_REF_MAX_AGE_DAYS = 90;
/** Sanitise a raw ?ref= value the same way capture always has (alnum . _ - only, capped 64). */
export function sanitiseRef(raw: unknown): string {
  const s = (Array.isArray(raw) ? raw[0] : raw);
  return (typeof s === 'string' ? s : '').trim().replace(/[^a-zA-Z0-9._-]/g, '').slice(0, 64);
}
/** The referral code this visitor already carries, or null. The ONE reader — register.tsx had its
 *  own regex, which is how two readers of one cookie drift apart. */
export function readGdRef(): string | null {
  return readCookie(GD_REF_COOKIE);
}

/**
 * Write gd_ref. Callers MUST have checked functional consent first — this is the sink, not the gate.
 *
 * FIRST CLICK WINS, and it is enforced HERE rather than asked of callers. A visitor who arrives on
 * one affiliate's link, reads for a week and arrives again on another's belongs to the first: the
 * introduction is what is being paid for, and it already happened. The rule lives at the sink
 * because it is the only place every write passes through — a caller-side check is a rule that
 * holds until somebody adds a second caller. Returns whether this call wrote.
 *
 * To REPLACE a code deliberately (an operator correcting an attribution), clear it first; that is
 * an explicit two-step and not something a stray `?ref=` in a URL can do.
 */
export function writeGdRef(clean: string): boolean {
  if (typeof document === 'undefined' || !clean) return false;
  if (readGdRef()) return false; // already introduced — the first link keeps the credit
  setCookie(GD_REF_COOKIE, encodeURIComponent(clean), GD_REF_MAX_AGE_DAYS);
  return true;
}
/** Remove gd_ref (e.g. functional consent withdrawn) — expired at both scopes. */
export function clearGdRef(): void {
  expireCookie(GD_REF_COOKIE);
}
