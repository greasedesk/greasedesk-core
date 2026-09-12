/**
 * File: pages/rep-site/robots.txt.ts
 * robots.txt FOR THE RESELLER HOST. Middleware rewrites reps.greasedesk.com/robots.txt here.
 *
 * ── WHY A ROUTE, AND WHY THE APEX FILE WAS LEFT ALONE ───────────────────────────────────────────
 * public/robots.txt is a static file, and a static file cannot vary by Host. Serving it on this host
 * would advertise the APEX sitemap from the reseller domain — pointing crawlers at a sitemap full of
 * URLs that 404 here. The alternative considered was turning the apex robots into a host-aware route;
 * that was rejected because it puts the live garage-site SEO surface at risk to add a second one.
 * This host gets its own file, at its own path, reached by a rewrite. The apex is untouched.
 *
 * WHAT IT ALLOWS: the two public pages. The PORTAL IS DISALLOWED — /rep and /rep/login carry
 * noindex meta of their own, and this says the same thing in the other place a crawler looks.
 */
import type { GetServerSideProps } from 'next';
import { REP_SITE_URL } from '@/lib/company-info';

export const getServerSideProps: GetServerSideProps = async ({ res }) => {
  const body = [
    'User-agent: *',
    'Allow: /',
    'Disallow: /rep',          // the portal — signed-in only, and noindex in its own <head>
    'Disallow: /api',
    '',
    `Sitemap: ${REP_SITE_URL}/sitemap.xml`,
    '',
  ].join('\n');
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Cache-Control', 'public, max-age=3600');
  res.write(body);
  res.end();
  return { props: {} };
};

export default function RepSiteRobots() { return null; }
