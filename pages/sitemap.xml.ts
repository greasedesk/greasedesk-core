/**
 * File: pages/sitemap.xml.ts
 * XML sitemap for the PUBLIC marketing surface only (never /admin or /api). Served at /sitemap.xml.
 * URLs are built from lib/company-info's canonical origin, so the domain lives in one place.
 */
import type { GetServerSideProps } from 'next';
import { absoluteUrl } from '@/lib/company-info';

const PUBLIC_PATHS = ['/', '/pricing', '/contact', '/register'];

export const getServerSideProps: GetServerSideProps = async ({ res }) => {
  const urls = PUBLIC_PATHS.map((p) => {
    const priority = p === '/' ? '1.0' : '0.7';
    return `  <url><loc>${absoluteUrl(p)}</loc><changefreq>weekly</changefreq><priority>${priority}</priority></url>`;
  }).join('\n');
  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>`;
  res.setHeader('Content-Type', 'application/xml');
  res.setHeader('Cache-Control', 'public, max-age=3600');
  res.write(xml);
  res.end();
  return { props: {} };
};

export default function Sitemap() { return null; }
