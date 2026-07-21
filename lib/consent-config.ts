/**
 * File: lib/consent-config.ts
 * Region-shaped consent — copy + defaults per region, so a new region (Ireland/EU is on the roadmap)
 * is a CONFIG entry, not a rebuild. Today GB is the only live region; IE is prepared so `/ie` needs
 * config only. Both default every non-necessary category OFF (opt-in) — the ICO now requires no
 * pre-ticked non-necessary boxes, and the EU has always required it; the per-region `defaults` knob
 * exists so a region *could* differ, but current UK+EU policy is opt-in everywhere.
 */
import { ALL_OFF, type ConsentChoice } from '@/lib/consent';

export type RegionConsentConfig = {
  region: string;
  defaults: ConsentChoice; // pre-toggle state in the Manage panel (opt-in → all off)
  copy: {
    title: string;
    body: string;
    acceptAll: string;
    rejectAll: string;
    manage: string;
    save: string;
    policyLink: string;
    necessary: { label: string; desc: string };
    functional: { label: string; desc: string };
    analytics: { label: string; desc: string };
    marketing: { label: string; desc: string };
  };
};

const NECESSARY_DESC = 'Sign-in/session security and your cookie choice itself. Always on — the site cannot work without them.';
const FUNCTIONAL_DESC = 'Remembers a referral code (gd_ref) so a reseller who sent you is credited. First-party, not cross-site tracking. Off by default.';
const ANALYTICS_DESC = 'Anonymous usage measurement to improve the product. None is in use today; this is off unless you turn it on.';
const MARKETING_DESC = 'Advertising or campaign cookies. None is in use today; off unless you turn it on.';

const GB: RegionConsentConfig = {
  region: 'GB',
  defaults: ALL_OFF,
  copy: {
    title: 'Your cookie choices',
    body: 'We use strictly-necessary cookies to keep the site working. With your consent we’d also use a referral cookie. We run no analytics or advertising cookies today. You can accept all, reject all, or choose per category.',
    acceptAll: 'Accept all',
    rejectAll: 'Reject all',
    manage: 'Manage',
    save: 'Save choices',
    policyLink: 'Cookie policy',
    necessary: { label: 'Strictly necessary', desc: NECESSARY_DESC },
    functional: { label: 'Functional', desc: FUNCTIONAL_DESC },
    analytics: { label: 'Analytics', desc: ANALYTICS_DESC },
    marketing: { label: 'Marketing', desc: MARKETING_DESC },
  },
};

// Ireland/EU — prepared, not yet live. Same opt-in defaults (EU enforcement is stricter, never laxer).
// Copy can diverge here without touching code. `/ie` resolves to this once the region ships.
const IE: RegionConsentConfig = {
  ...GB,
  region: 'IE',
  copy: {
    ...GB.copy,
    body: 'We use strictly-necessary cookies to keep the site working. Any other cookie is off until you choose to allow it. We run no analytics or advertising cookies today. Accept all, reject all, or choose per category — your choice is recorded.',
  },
};

const REGIONS: Record<string, RegionConsentConfig> = { GB, IE };

/** Resolve the region for a request/route. Today GB; `/ie` (or a future geo signal) → IE. One knob. */
export function resolveConsentRegion(pathname?: string | null): string {
  if (pathname && /^\/ie(\/|$)/.test(pathname)) return 'IE';
  return 'GB';
}
export function getRegionConsentConfig(region: string): RegionConsentConfig {
  return REGIONS[region] ?? GB;
}
