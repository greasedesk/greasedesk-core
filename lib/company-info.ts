/**
 * File: lib/company-info.ts
 * THE single source of GreaseDesk Ltd's public identity + legal facts. Footer, contact page, SEO
 * schema, emails — EVERY surface reads from here; never hardcode a company number, office address,
 * phone, email or trademark in a template. Change a fact once, it changes everywhere.
 */
export const COMPANY = {
  legalName: 'GreaseDesk Ltd',
  tradingName: 'GreaseDesk',
  trademark: 'GreaseDesk™',
  companyNumber: '17312623',
  // Registered office (Companies House). One string + structured parts for schema.org PostalAddress.
  office: {
    line1: 'Unit 7 Tinsley Street',
    line2: 'Great Bridge',
    locality: 'West Midlands',
    postcode: 'DY4 7LH',
    country: 'GB',
  },
  phone: '0330 555 3333',
  phoneE164: '+443305553333', // for tel: links
  email: 'hugh@greasedesk.com',
  // Canonical public origin — used for OG/canonical URLs, sitemap and schema. No trailing slash.
  siteUrl: 'https://greasedesk.com',
  logoPath: '/greasedesk-Logo.png',
} as const;

/** One-line registered office, e.g. "Unit 7 Tinsley Street, Great Bridge, West Midlands, DY4 7LH". */
export function officeOneLine(): string {
  const o = COMPANY.office;
  return [o.line1, o.line2, o.locality, o.postcode].filter(Boolean).join(', ');
}

/** Absolute URL for a site-relative path (OG, canonical, sitemap). */
export function absoluteUrl(path = '/'): string {
  return `${COMPANY.siteUrl}${path.startsWith('/') ? path : `/${path}`}`;
}
