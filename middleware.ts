/**
 * File: middleware.ts
 * HOST → PATH routing for the platform-tier origin isolation (Option A: one Vercel project, two
 * hosts). The Engine Room (operator portal) moves to its OWN origin, er.greasedesk.com, so it gets a
 * separate cookie jar (cookies are host-only — see the guardrail in pages/api/auth/[...nextauth].ts),
 * a stricter CSP later, and an optional IP-allowlist later. There is exactly ONE door.
 *
 *   • On er.greasedesk.com — expose ONLY the Engine Room: /superadmin/* and /api/superadmin/*, the
 *     brand image (one exact path, see BRAND_ASSET), plus
 *     the auth endpoints (so an operator can sign in there) and Next internals. EVERYTHING else,
 *     including "/", 404s. The tenant app is NOT reachable at er.
 *   • On reps.greasedesk.com — expose the PUBLIC RESELLER SITE and the rep portal: /rep-site/*,
 *     /api/rep-site/*, /rep/* and /api/rep/*, plus this host's own /robots.txt and /sitemap.xml (by
 *     rewrite). A rep is self-employed, belongs to no garage, and invoices US; the portal must not
 *     sit on the tenant origin, where it would share the tenant cookie jar. EVERYTHING else 404s.
 *     The ROOT serves the public page to a visitor and the portal to a signed-in rep.
 *   • On the apex (greasedesk.com and anything else) — BOTH other doors are CLOSED: /superadmin/*,
 *     /api/superadmin/*, /rep/* and /api/rep/* all 404. The tenant app is otherwise untouched.
 *
 * 404 not redirect, and not 403: undiscoverable, and we never leak that the door moved. The operator
 * and rep GUARDS (lib/operator-auth, lib/rep-auth) are unchanged and still fire — this only decides
 * which host may reach them; a non-operator hitting er./superadmin/* still 404s at the guard, and a
 * signed-out rep hitting reps./rep gets the application's 404, not this one.
 *
 * ── /rep MOVED. IT WAS REACHABLE ON THE APEX UNTIL 2026-09-09 ───────────────────────────────────
 * pages/rep/* shipped with layer 1 and has been served at greasedesk.com/rep ever since, on the
 * tenant origin and therefore in the tenant cookie jar. Nothing depended on that — no gate drove it
 * and no link pointed at it — which is why the move is a middleware change rather than a migration.
 */
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { underPath } from '@/lib/anchored-match';

const ER_HOST = 'er.greasedesk.com';
const REP_HOST = 'reps.greasedesk.com';

const isEngineRoom = (p: string) => underPath(p, '/superadmin') || underPath(p, '/api/superadmin');
/**
 * EXACT SEGMENT OR NOTHING — underPath (lib/anchored-match) is the one place that rule lives now.
 *
 * `startsWith('/api/rep')` would also match /api/reports/vat-summary — a tenant's VAT return, which
 * exists. That line was written here once, by hand; it is the case the helper was built from, and
 * anchored-match-gate bans writing a path prefix by hand anywhere in the app or the suite.
 * /admin/settings/rep sits one directory up from /rep, and the next path of that shape is one rename
 * away. rep-host-gate DRIVES both paths; a matcher that reads as correct can still be wrong about the
 * one path nobody listed.
 */
const isRepPortal = (p: string) => underPath(p, '/rep') || underPath(p, '/api/rep');
/**
 * THE PUBLIC RESELLER SITE — one named prefix, and that is the whole boundary (owner, 2026-09-12).
 *
 * Pages, api and static assets all live under /rep-site, so the host's allow-list grows by ONE entry
 * rather than by a file at a time. The rejected alternative was an exact-match list that gains a line
 * per image: "a boundary nobody notices widening". This one is visible in a single grep, and
 * rep-site-gate proves that nothing OUTSIDE it is reachable here — /public included.
 *
 * underPath, not startsWith: '/rep-site' must not be matched by the portal's own '/rep' check either,
 * which is why isRepPortal above uses the same helper. '/rep-site' is not a path under '/rep'.
 */
const isRepSite = (p: string) => underPath(p, '/rep-site') || underPath(p, '/api/rep-site');
const isAuth = (p: string) => underPath(p, '/api/auth'); // shared: operator login on er., tenant login on apex
const isNextInternal = (p: string) => underPath(p, '/_next'); // matcher already drops /_next/static + image
/**
 * The brand image, and nothing else from /public.
 *
 * er. serves ONLY the Engine Room, so every path under /public 404s here — which is why the shell
 * carried a hand-drawn "ER" square instead of the product's logo: an <img> to /public would have
 * been a permanently broken image. This opens exactly ONE file, by exact match: a public brand
 * asset that is already served to anyone who loads the marketing site, carrying no tenant data and
 * no behaviour. The door stays otherwise shut — a prefix or a wildcard here would re-open /public.
 *
 * EXACT MATCH, AND THE CASE IS PART OF IT: the file is greasedesk-Logo.png with a capital L, and
 * this comparison is `===`. A lowercased constant would match nothing here and 404 the logo in
 * production while working on a case-insensitive laptop.
 */
const BRAND_ASSET = '/greasedesk-Logo.png';

const notFound = () => new NextResponse('Not Found', { status: 404 });

export function middleware(req: NextRequest) {
  const host = (req.headers.get('host') ?? '').split(':')[0].toLowerCase();
  const { pathname } = req.nextUrl;

  if (host === ER_HOST) {
    // er. is the Engine Room and NOTHING else.
    // The ROOT is the front door: rewrite it to /superadmin, whose getServerSideProps routes on the
    // session principal (operator → role landing; wrong class → 404; logged out → login).
    if (pathname === '/') return NextResponse.rewrite(new URL('/superadmin', req.url));
    if (isEngineRoom(pathname) || isAuth(pathname) || isNextInternal(pathname) || pathname === BRAND_ASSET) return NextResponse.next();
    return notFound(); // every tenant route still 404s on er.
  }

  if (host === REP_HOST) {
    // reps. is the PUBLIC RESELLER SITE and the rep portal, and nothing else. Still an allow-list
    // rather than a block-list — a block-list on a host this isolated is a list somebody forgets to
    // add to.
    //
    // THE ROOT IS NOW A PUBLIC PAGE. It used to rewrite to /rep, which redirected a visitor with no
    // session to /rep/login — so the bare domain was the sign-in page. The rewrite now lands on the
    // public site, and /rep-site's own getServerSideProps sends a SIGNED-IN REP on to /rep, so their
    // front door is unchanged. The session is read there and not here on purpose: lib/rep-auth
    // records why a JWT decrypt per request to choose a rewrite is a cost this layer need not pay.
    if (pathname === '/') return NextResponse.rewrite(new URL('/rep-site', req.url));
    // THIS HOST'S OWN robots AND sitemap. public/robots.txt is a static file and cannot vary by Host;
    // served here it would advertise the APEX sitemap from the reseller domain, pointing crawlers at
    // URLs that 404 here. The apex file is left completely untouched — these are rewrites, not a
    // rewiring of a live SEO surface.
    /**
     * TERMS LIVE AT /terms, the URL a person types and the one this codebase already means by terms
     * (the apex serves /terms from the Content system). They were shipped at /rep-site/terms on
     * 2026-09-12 — inside the namespace, which made the BOUNDARY tidy and the URL wrong — and
     * production 404'd the obvious address for as long as that stood. The page file stays inside
     * /rep-site so it keeps 404ing on the apex for free; only the public address moved.
     */
    if (pathname === '/terms') return NextResponse.rewrite(new URL('/rep-site/terms', req.url));
    // The old address, kept as a 308 rather than a 404: it was live and crawlable, however briefly,
    // and a redirect costs nothing. A rewrite does not re-enter middleware, so this cannot loop with
    // the line above — the rewritten request goes straight to the route.
    if (pathname === '/rep-site/terms') return NextResponse.redirect(new URL('/terms', req.url), 308);
    if (pathname === '/robots.txt') return NextResponse.rewrite(new URL('/rep-site/robots.txt', req.url));
    if (pathname === '/sitemap.xml') return NextResponse.rewrite(new URL('/rep-site/sitemap.xml', req.url));
    if (isRepSite(pathname) || isRepPortal(pathname) || isAuth(pathname) || isNextInternal(pathname) || pathname === BRAND_ASSET) return NextResponse.next();
    return notFound(); // the tenant app AND the Engine Room both 404 on reps.
  }

  /**
   * /reseller MOVED TO ITS OWN HOST (2026-09-12) — and the redirect lives HERE, not in
   * next.config.js's redirects(), because it is a decision about a host and this is the file that
   * routes on host.
   *
   * Two earlier attempts, both wrong, both caught by rep-site-gate rather than by reading:
   *   • `redirects()` with `has: [{ type: 'host', value: 'greasedesk.com' }]` — the host condition
   *     compares the Host header VERBATIM, so it never matches when a port is present. It worked in
   *     production and was silently dead on localhost: a rule no gate could prove.
   *   • `redirects()` unconditional, on the belief that middleware runs first and would 404 the path
   *     on the other hosts. It does not — redirects run BEFORE middleware — so /reseller redirected
   *     on reps. and er. too, breaking "er. 404s everything".
   *
   * 308 rather than 302: the page was indexed and a temporary redirect passes no ranking to its new
   * home. 308 is the method-preserving permanent status and is what Next emits for `permanent: true`.
   */
  if (pathname === '/reseller') return NextResponse.redirect(new URL('https://reps.greasedesk.com/'), 308);

  // Apex / any other host: neither the Engine Room, the rep portal, nor the reseller site is here.
  // The reseller site is closed on the apex for the same reason the portal is — ONE door per surface.
  // Its former apex page, /reseller, is a 308 to this host — see the apex branch below.
  if (isEngineRoom(pathname) || isRepPortal(pathname) || isRepSite(pathname)) return notFound();
  return NextResponse.next(); // tenant app unchanged
}

export const config = {
  // Run on everything except static assets — the er. host must be able to 404 ARBITRARY tenant
  // paths, which requires the middleware to see them. One host string-compare per request on the apex.
  // The root '/' is listed EXPLICITLY: the negative-lookahead pattern below does not match it, so
  // without this er.greasedesk.com/ would fall through to the tenant homepage (it must 404 on er.).
  matcher: ['/', '/((?!_next/static|_next/image|favicon.ico).*)'],
};
