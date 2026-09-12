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
 * ── THE DIRECTIVE THAT WAS WRONG, AND WHY (2026-09-12) ──────────────────────────────────────────
 * This said `Disallow: /rep` and nothing else. robots.txt matching is PREFIX-BASED on the path
 * (RFC 9309 §2.2.2), so that disallowed /rep-site/terms and /rep-site/og.png as well as the portal —
 * while the sitemap beside it advertised /rep-site/terms. Two files contradicting each other, with
 * the forbidding one winning, so the page asked to be indexable was not.
 *
 * `Allow: /rep-site/` is what carves the hole: the longest matching pattern wins and a tie goes to
 * allow, so /rep-site/* is crawlable while /rep and /rep/login are not. That precedence is not
 * assumed — rep-site-gate evaluates these directives with lib/robots-rules, an RFC 9309 matcher, and
 * asserts the two outcomes that matter. A clause proving a LINE EXISTS proves nothing about what the
 * line does; that was the defect, not the wording.
 */
import type { GetServerSideProps } from 'next';
import { REP_SITE_URL } from '@/lib/company-info';

export const getServerSideProps: GetServerSideProps = async ({ res }) => {
  const body = [
    'User-agent: *',
    'Allow: /',
    // LONGER THAN THE Disallow BELOW, so it wins: the public site stays crawlable.
    'Allow: /rep-site/',
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
