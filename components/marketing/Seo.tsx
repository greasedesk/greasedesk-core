/**
 * File: components/marketing/Seo.tsx
 * Per-page SEO for the public marketing site: <title>, meta description, canonical, Open Graph +
 * Twitter card, and JSON-LD (Organization site-wide, SoftwareApplication opt-in). ALL identity facts
 * read from lib/company-info — never hardcoded. This is a ranking surface; every page ships complete meta.
 */
import Head from 'next/head';
import { COMPANY, absoluteUrl, officeOneLine } from '@/lib/company-info';
import { MONTHLY_PRICE_POUNDS, GARAGE_VAT_REGISTERED } from '@/lib/billing-pricing';

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
  applicationCategory: 'BusinessApplication',
  operatingSystem: 'Web',
  description: 'Garage management software: job cards, bookings, invoicing and a live profit-and-loss view.',
  offers: {
    '@type': 'Offer',
    price: String(MONTHLY_PRICE_POUNDS),
    priceCurrency: 'GBP',
    // Price shown is per location, per month. VAT excluded while GreaseDesk Ltd is not registered.
    ...(GARAGE_VAT_REGISTERED ? {} : { valueAddedTaxIncluded: false }),
  },
  publisher: { '@type': 'Organization', name: COMPANY.legalName },
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
