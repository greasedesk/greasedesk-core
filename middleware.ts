/**
 * File: middleware.ts
 * HOST → PATH routing for the platform-tier origin isolation (Option A: one Vercel project, two
 * hosts). The Engine Room (operator portal) moves to its OWN origin, er.greasedesk.com, so it gets a
 * separate cookie jar (cookies are host-only — see the guardrail in pages/api/auth/[...nextauth].ts),
 * a stricter CSP later, and an optional IP-allowlist later. There is exactly ONE door.
 *
 *   • On er.greasedesk.com — expose ONLY the Engine Room: /superadmin/* and /api/superadmin/*, plus
 *     the auth endpoints (so an operator can sign in there) and Next internals. EVERYTHING else,
 *     including "/", 404s. The tenant app is NOT reachable at er.
 *   • On the apex (greasedesk.com and anything else) — the Engine Room door is CLOSED: /superadmin/*
 *     and /api/superadmin/* 404 (single door, at er. only). The tenant app is otherwise untouched.
 *
 * 404 not redirect, and not 403: undiscoverable, and we never leak that the door moved. The operator
 * GUARDS (lib/operator-auth) are unchanged and still fire — this only decides which host may reach
 * them; a non-operator hitting er./superadmin/* still 404s at the guard.
 */
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

const ER_HOST = 'er.greasedesk.com';

const isEngineRoom = (p: string) => p === '/superadmin' || p.startsWith('/superadmin/') || p.startsWith('/api/superadmin/');
const isAuth = (p: string) => p.startsWith('/api/auth/'); // shared: operator login on er., tenant login on apex
const isNextInternal = (p: string) => p.startsWith('/_next/'); // matcher already drops /_next/static + image

const notFound = () => new NextResponse('Not Found', { status: 404 });

export function middleware(req: NextRequest) {
  const host = (req.headers.get('host') ?? '').split(':')[0].toLowerCase();
  const { pathname } = req.nextUrl;

  if (host === ER_HOST) {
    // er. is the Engine Room and NOTHING else.
    // The ROOT is the front door: rewrite it to /superadmin, whose getServerSideProps routes on the
    // session principal (operator → role landing; wrong class → 404; logged out → login).
    if (pathname === '/') return NextResponse.rewrite(new URL('/superadmin', req.url));
    if (isEngineRoom(pathname) || isAuth(pathname) || isNextInternal(pathname)) return NextResponse.next();
    return notFound(); // every tenant route still 404s on er.
  }

  // Apex / any other host: the Engine Room is not here.
  if (isEngineRoom(pathname)) return notFound();
  return NextResponse.next(); // tenant app unchanged
}

export const config = {
  // Run on everything except static assets — the er. host must be able to 404 ARBITRARY tenant
  // paths, which requires the middleware to see them. One host string-compare per request on the apex.
  // The root '/' is listed EXPLICITLY: the negative-lookahead pattern below does not match it, so
  // without this er.greasedesk.com/ would fall through to the tenant homepage (it must 404 on er.).
  matcher: ['/', '/((?!_next/static|_next/image|favicon.ico).*)'],
};
