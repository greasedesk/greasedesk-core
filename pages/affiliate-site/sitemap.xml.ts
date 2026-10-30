/**
 * File: pages/affiliate-site/sitemap.xml.ts
 * Sitemap FOR THE AFFILIATE HOST. Middleware rewrites affiliates.greasedesk.com/sitemap.xml here.
 *
 * Its own file because pages/sitemap.xml.ts builds every URL through absoluteUrl(), which is
 * hardcoded to the apex origin — running it here would list greasedesk.com URLs under the affiliate
 * domain. Three hosts, three sitemaps, one origin constant each.
 *
 * SHORT, because the site is short. /terms is DELIBERATELY ABSENT while its text is a placeholder:
 * the route is live and the gate proves it resolves, but there is nothing to gain by asking a
 * crawler to index an unfinished page. It goes in with the real document.
 */
import type { GetServerSideProps } from 'next';
import { AFFILIATE_SITE_URL } from '@/lib/company-info';

const PATHS: { path: string; priority: string; changefreq: string }[] = [
  { path: '/', priority: '1.0', changefreq: 'weekly' },
];

export const getServerSideProps: GetServerSideProps = async ({ res }) => {
  const urls = PATHS.map(({ path, priority, changefreq }) =>
    `  <url><loc>${AFFILIATE_SITE_URL}${path === '/' ? '/' : path}</loc><changefreq>${changefreq}</changefreq><priority>${priority}</priority></url>`);
  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join('\n')}\n</urlset>`;
  res.setHeader('Content-Type', 'application/xml');
  res.setHeader('Cache-Control', 'public, max-age=3600');
  res.write(xml);
  res.end();
  return { props: {} };
};

export default function AffiliateSiteSitemap() { return null; }
