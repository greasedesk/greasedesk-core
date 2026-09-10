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
 *   • On reps.greasedesk.com — expose ONLY the rep portal: /rep/* and /api/rep/*, on the same
 *     terms. A rep is self-employed, belongs to no garage, and invoices US; the portal must not sit
 *     on the tenant origin, where it would share the tenant cookie jar. EVERYTHING else 404s.
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
    // reps. is the rep portal and NOTHING else. Same shape as er. above, deliberately: one door,
    // one rewrite at the root, and an allow-list rather than a block-list — a block-list on a host
    // this isolated is a list somebody forgets to add to.
    if (pathname === '/') return NextResponse.rewrite(new URL('/rep', req.url));
    if (isRepPortal(pathname) || isAuth(pathname) || isNextInternal(pathname) || pathname === BRAND_ASSET) return NextResponse.next();
    return notFound(); // the tenant app AND the Engine Room both 404 on reps.
  }

  // Apex / any other host: neither the Engine Room nor the rep portal is here.
  if (isEngineRoom(pathname) || isRepPortal(pathname)) return notFound();
  return NextResponse.next(); // tenant app unchanged
}

export const config = {
  // Run on everything except static assets — the er. host must be able to 404 ARBITRARY tenant
  // paths, which requires the middleware to see them. One host string-compare per request on the apex.
  // The root '/' is listed EXPLICITLY: the negative-lookahead pattern below does not match it, so
  // without this er.greasedesk.com/ would fall through to the tenant homepage (it must 404 on er.).
  matcher: ['/', '/((?!_next/static|_next/image|favicon.ico).*)'],
};
