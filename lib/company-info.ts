/**
 * File: lib/company-info.ts
 * THE single source of GreaseDesk Ltd's PUBLIC identity + legal facts. Footer, contact page and SEO
 * schema read from here; never hardcode a company number, office address, phone or trademark in a
 * template. NO EMAIL LIVES HERE — this file is client-imported, so a published address would ship in
 * served JS and be scrapable. Contact is form-only; the destination is server-side env (CONTACT_FORM_TO).
 */
export const COMPANY = {
  legalName: 'GreaseDesk Ltd',
  tradingName: 'GreaseDesk',
  trademark: 'GreaseDesk™',
  companyNumber: '17312623',
  // Registered office — VERBATIM from Companies House ("Unit 7 Tinsley Street, Tipton, England,
  // DY4 7LH"). One string + structured parts for schema.org PostalAddress.
  office: {
    line1: 'Unit 7 Tinsley Street',
    locality: 'Tipton',
    region: 'England',
    postcode: 'DY4 7LH',
    country: 'GB',
  },
  phone: '0330 555 3333',
  phoneE164: '+443305553333', // for tel: links — phone is the only published non-form contact route
  // Canonical public origin — used for OG/canonical URLs, sitemap and schema. No trailing slash.
  siteUrl: 'https://greasedesk.com',
  logoPath: '/greasedesk-Logo.png',      // full lockup (mark + wordmark) — OG / schema image
  markPath: '/android-chrome-512x512.png', // the gear-and-spanner MARK alone, transparent — header/UI
} as const;

/** One-line registered office, verbatim: "Unit 7 Tinsley Street, Tipton, England, DY4 7LH". */
export function officeOneLine(): string {
  const o = COMPANY.office;
  return [o.line1, o.locality, o.region, o.postcode].filter(Boolean).join(', ');
}

/** Absolute URL for a site-relative path (OG, canonical, sitemap). */
export function absoluteUrl(path = '/'): string {
  return `${COMPANY.siteUrl}${path.startsWith('/') ? path : `/${path}`}`;
}
