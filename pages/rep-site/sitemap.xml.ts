/**
 * File: pages/rep-site/sitemap.xml.ts
 * Sitemap FOR THE RESELLER HOST. Middleware rewrites reps.greasedesk.com/sitemap.xml here.
 *
 * Its own file for the same reason as robots: pages/sitemap.xml.ts builds every URL through
 * absoluteUrl(), which is hardcoded to the apex origin, so running it on this host would list
 * greasedesk.com URLs under a reseller domain. Two hosts, two sitemaps, one origin constant each.
 *
 * The list is SHORT and hand-written because the site is short. The portal is absent deliberately —
 * signed-in only, noindex, and Disallowed in robots — and so is /terms, while its prose is
 * placeholder.
 */
import type { GetServerSideProps } from 'next';
import { REP_SITE_URL } from '@/lib/company-info';

const PATHS: { path: string; priority: string; changefreq: string }[] = [
  { path: '/', priority: '1.0', changefreq: 'weekly' },
  // /terms is DELIBERATELY ABSENT while its prose is placeholder — the route is live and the gate
  // still proves it resolves, but there is no point asking a crawler to index an unfinished page.
  // Add it back with the solicitor's text.
];

export const getServerSideProps: GetServerSideProps = async ({ res }) => {
  const urls = PATHS.map(({ path, priority, changefreq }) =>
    `  <url><loc>${REP_SITE_URL}${path === '/' ? '/' : path}</loc><changefreq>${changefreq}</changefreq><priority>${priority}</priority></url>`);
  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join('\n')}\n</urlset>`;
  res.setHeader('Content-Type', 'application/xml');
  res.setHeader('Cache-Control', 'public, max-age=3600');
  res.write(xml);
  res.end();
  return { props: {} };
};

export default function RepSiteSitemap() { return null; }
