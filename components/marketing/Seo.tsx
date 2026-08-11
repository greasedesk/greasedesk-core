/**
 * File: components/marketing/Seo.tsx
 * Per-page SEO for the public marketing site: <title>, meta description, canonical, Open Graph +
 * Twitter card, and JSON-LD (Organization site-wide, SoftwareApplication opt-in). ALL identity facts
 * read from lib/company-info — never hardcoded. This is a ranking surface; every page ships complete meta.
 */
import Head from 'next/head';
import { COMPANY, absoluteUrl, officeOneLine } from '@/lib/company-info';
import { MONTHLY_PRICE_POUNDS, garageVatRegistered } from '@/lib/billing-pricing';
import { TRIAL_PERIOD_DAYS } from '@/lib/stripe';

type Props = {
  title: string;         // full <title> (page-specific)
  description: string;   // meta description + OG description
  path: string;          // site-relative path for canonical + OG url, e.g. '/pricing'
  softwareApp?: boolean;  // also emit a SoftwareApplication offer (home + pricing)
};

const organizationLd = () => ({
  '@context': 'https://schema.org',
  '@type': 'Organization',
  name: COMPANY.legalName,
  legalName: COMPANY.legalName,
  url: COMPANY.siteUrl,
  logo: absoluteUrl(COMPANY.logoPath),
  // Companies House registered number. schema.org has no `companyNumber`; an identifier with an
  // explicit propertyID is the correct expression, and says WHICH register the number belongs to.
  identifier: {
    '@type': 'PropertyValue',
    propertyID: 'GB:CRN',
    value: COMPANY.companyNumber,
  },
  areaServed: { '@type': 'Country', name: 'GB' },
  // NO email in the schema (would be scrapable) — phone + address only.
  telephone: COMPANY.phoneE164,
  address: {
    '@type': 'PostalAddress',
    streetAddress: COMPANY.office.line1,
    addressLocality: COMPANY.office.locality,
    addressRegion: COMPANY.office.region,
    postalCode: COMPANY.office.postcode,
    addressCountry: COMPANY.office.country,
  },
  contactPoint: {
    '@type': 'ContactPoint',
    contactType: 'sales',
    telephone: COMPANY.phoneE164,
  },
});

const softwareAppLd = () => ({
  '@context': 'https://schema.org',
  '@type': 'SoftwareApplication',
  name: COMPANY.tradingName,
  url: COMPANY.siteUrl,
  applicationCategory: 'BusinessApplication',
  applicationSubCategory: 'Garage management software',
  operatingSystem: 'Web',
  description: 'Garage management software: job cards, bookings, invoicing and a live profit-and-loss view.',
  // GB-only by admission rule (one allow-list in the country writer), so the schema says so rather
  // than implying we sell everywhere.
  areaServed: { '@type': 'Country', name: 'GB' },
  audience: { '@type': 'Audience', audienceType: 'Independent vehicle repair garages' },
  // What the product actually does. Every line is a shipped surface — nothing part-built is
  // claimed, because a feature list is a promise a search result will repeat back to a garage.
  featureList: [
    'Job cards with a gated workflow',
    'Diary and bookings with capacity planning',
    'Quotes with versioning and customer acceptance',
    'VAT invoicing on a gapless numbered series',
    'Payments, account customers on terms, and debtor tracking',
    'Live profit-and-loss, capacity and utilisation dashboards',
    'Parts and labour catalogue with cost and margin',
    'Customer messaging by email and SMS',
    'Mobile app for mechanics',
  ],
  offers: [
    {
      '@type': 'Offer',
      name: 'Subscription',
      price: String(MONTHLY_PRICE_POUNDS),
      priceCurrency: 'GBP',
      // A BARE price reads as a flat £75 for the product. It is £75 PER LOCATION PER MONTH, and
      // UnitPriceSpecification is the only way to say that in a machine-readable way.
      priceSpecification: {
        '@type': 'UnitPriceSpecification',
        price: String(MONTHLY_PRICE_POUNDS),
        priceCurrency: 'GBP',
        unitCode: 'MON',
        referenceQuantity: { '@type': 'QuantitativeValue', value: 1, unitText: 'location' },
        // ── OMITTED WHEN NOT REGISTERED, NEVER `false` (ruling 2026-08-11) ──────────────────────
        // `false` is a positive claim that the price EXCLUDES VAT, which implies VAT will be added
        // on top. GreaseDesk Ltd is not VAT-registered, so no VAT applies at all and there is
        // nothing to add — saying `false` would advertise a charge that does not exist. When
        // registration lands the flag flips to true and the field appears, which is what Terms v2
        // already states: VAT is INCLUDED in the £75.
        ...(garageVatRegistered() ? { valueAddedTaxIncluded: true } : {}),
      },
    },
    {
      '@type': 'Offer',
      name: `${TRIAL_PERIOD_DAYS}-day free trial`,
      price: '0',
      priceCurrency: 'GBP',
      eligibleDuration: { '@type': 'QuantitativeValue', value: TRIAL_PERIOD_DAYS, unitCode: 'DAY' },
    },
  ],
  publisher: { '@type': 'Organization', name: COMPANY.legalName },
  // DELIBERATELY ABSENT: aggregateRating and review. There are none. Emitting them would be a
  // fabrication and a structured-data violation, and no amount of SEO benefit buys that back.
});

export default function Seo({ title, description, path, softwareApp = false }: Props) {
  const url = absoluteUrl(path);
  const ogImage = absoluteUrl(COMPANY.logoPath);
  return (
    <Head>
      <title>{title}</title>
      <meta name="description" content={description} />
      <link rel="canonical" href={url} />
      {/* Open Graph */}
      <meta property="og:type" content="website" />
      <meta property="og:site_name" content={COMPANY.tradingName} />
      <meta property="og:title" content={title} />
      <meta property="og:description" content={description} />
      <meta property="og:url" content={url} />
      <meta property="og:image" content={ogImage} />
      {/* Twitter */}
      <meta name="twitter:card" content="summary_large_image" />
      <meta name="twitter:title" content={title} />
      <meta name="twitter:description" content={description} />
      <meta name="twitter:image" content={ogImage} />
      {/* JSON-LD */}
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(organizationLd()) }} />
      {softwareApp && (
        <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(softwareAppLd()) }} />
      )}
      {/* aria/meta hint: office address is public (Companies House) */}
      <meta name="business:contact_data:street_address" content={officeOneLine()} />
    </Head>
  );
}
