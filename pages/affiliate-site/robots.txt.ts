/**
 * File: pages/affiliate-site/robots.txt.ts
 * robots.txt FOR THE AFFILIATE HOST. Middleware rewrites affiliates.greasedesk.com/robots.txt here.
 *
 * Its own route for the reason the reseller host's is: public/robots.txt is a static file and a
 * static file cannot vary by Host, so serving it here would advertise the APEX sitemap from the
 * affiliate domain and point crawlers at URLs that 404 on this host. The apex file is untouched.
 *
 * ── THE PREFIX TRAP, ALREADY PAID FOR ONCE ──────────────────────────────────────────────────────
 * robots.txt matching is PREFIX-BASED on the path (RFC 9309 §2.2.2), which is how the reseller host
 * came to disallow its own public pages with `Disallow: /rep`. There is no equivalent collision
 * here — nothing on this host sits under a disallowed prefix — so the rules are deliberately plain:
 * everything under the site is crawlable, /api is not. affiliate-site-gate evaluates these
 * directives with lib/robots-rules (an RFC 9309 matcher) rather than checking that a line exists,
 * because a clause proving a LINE IS PRESENT proves nothing about what the line does.
 */
import type { GetServerSideProps } from 'next';
import { AFFILIATE_SITE_URL } from '@/lib/company-info';

export const getServerSideProps: GetServerSideProps = async ({ res }) => {
  const body = [
    'User-agent: *',
    'Allow: /',
    'Disallow: /api',
    '',
    `Sitemap: ${AFFILIATE_SITE_URL}/sitemap.xml`,
    '',
  ].join('\n');
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Cache-Control', 'public, max-age=3600');
  res.write(body);
  res.end();
  return { props: {} };
};

export default function AffiliateSiteRobots() { return null; }
