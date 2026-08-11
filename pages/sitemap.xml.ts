/**
 * File: pages/sitemap.xml.ts
 * XML sitemap for the PUBLIC marketing surface only (never /admin or /api). Served at /sitemap.xml.
 * URLs are built from lib/company-info's canonical origin, so the domain lives in one place.
 *
 * ── THE CONTENT DOCUMENTS ARE DERIVED, NOT LISTED ───────────────────────────────────────────────
 * The hand-built marketing pages are a real list, because they are real files. The content-system
 * documents are NOT: the whole point of pages/[slug] is that a document published in the Engine
 * Room gets a working URL with no deploy, and a hardcoded list silently excludes it from search —
 * /cookies, /privacy and /terms were all missing, and so would the next one have been. So they are
 * read from the same published state the public route resolves against.
 *
 * A DATABASE READ CANNOT BE ALLOWED TO EMPTY THE SITEMAP. If the query fails, the static paths are
 * still served: a sitemap missing its legal pages is a small loss, and a sitemap that 500s or comes
 * back empty tells a crawler the site has no pages at all.
 */
import type { GetServerSideProps } from 'next';
import { absoluteUrl } from '@/lib/company-info';

const PUBLIC_PATHS = ['/', '/pricing', '/contact', '/reseller', '/register'];

const entry = (loc: string, priority: string, changefreq: string, lastmod?: string | null) =>
  `  <url><loc>${loc}</loc>${lastmod ? `<lastmod>${lastmod}</lastmod>` : ''}<changefreq>${changefreq}</changefreq><priority>${priority}</priority></url>`;

export const getServerSideProps: GetServerSideProps = async ({ res }) => {
  const urls = PUBLIC_PATHS.map((p) => entry(absoluteUrl(p), p === '/' ? '1.0' : '0.7', 'weekly'));

  try {
    const { prisma } = await import('@/lib/db');
    const { publishedSlugs } = await import('@/lib/content');
    const docs = await publishedSlugs(prisma, 'GB');
    for (const d of docs) {
      if (PUBLIC_PATHS.includes(`/${d.slug}`)) continue; // a file route already claims it
      // Legal documents change rarely and are not what anyone should land on first — hence
      // 'yearly' and a low priority. lastmod is the real publish date, so a re-published policy
      // is recrawled rather than assumed stale.
      urls.push(entry(absoluteUrl(`/${d.slug}`), '0.3', 'yearly', d.lastModified ? d.lastModified.toISOString().slice(0, 10) : null));
    }
  } catch (e) {
    console.error('[sitemap] could not read published documents — serving the static paths only', e);
  }

  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join('\n')}\n</urlset>`;
  res.setHeader('Content-Type', 'application/xml');
  res.setHeader('Cache-Control', 'public, max-age=3600');
  res.write(xml);
  res.end();
  return { props: {} };
};

export default function Sitemap() { return null; }
