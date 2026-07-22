/**
 * File: lib/nav.ts
 * Navigation resolution for the marketing site — footer + main-nav links come from the Content system
 * (NavLink), not hardcoded in SiteChrome, so a document can be linked without a code change. A link
 * targets an internal DOCUMENT (slug → /slug), an internal ROUTE (a path), or an EXTERNAL URL. There is
 * a hardcoded FALLBACK so the site never renders an empty nav (before seeding, or on a resolve error).
 */
import type { PrismaClient, Prisma } from '@prisma/client';

type Db = PrismaClient | Prisma.TransactionClient;
export type NavPlacement = 'footer' | 'main';
export type NavKind = 'document' | 'route' | 'external';
export const NAV_PLACEMENTS: NavPlacement[] = ['footer', 'main'];
export const NAV_KINDS: NavKind[] = ['document', 'route', 'external'];
export type PublicNavLink = { label: string; href: string; external: boolean };

/** Turn a NavLink into a public href: a document slug → /slug; route/external used verbatim. */
export function hrefFor(kind: string, target: string): string {
  const t = String(target || '').trim();
  if (kind === 'document') return '/' + t.replace(/^\/+/, '');
  return t;
}

/** Pre-config nav — used when the DB has no links for a placement, so the site never breaks. */
export const FALLBACK_NAV: Record<NavPlacement, PublicNavLink[]> = {
  main: [
    { label: 'Features', href: '/#features', external: false },
    { label: 'Pricing', href: '/pricing', external: false },
    { label: 'Contact', href: '/contact', external: false },
  ],
  footer: [
    { label: 'Pricing', href: '/pricing', external: false },
    { label: 'Contact', href: '/contact', external: false },
    { label: 'Start free trial', href: '/register', external: false },
    { label: 'Sign in', href: '/admin/login', external: false },
    { label: 'Become a reseller', href: '/reseller', external: false },
    { label: 'Cookie policy', href: '/cookies', external: false },
  ],
};

/** Resolve the region's enabled links per placement, ordered; falls back per placement when empty. */
export async function resolvePublicNav(db: Db, country = 'GB'): Promise<Record<NavPlacement, PublicNavLink[]>> {
  let rows: any[] = [];
  try { rows = await (db as any).navLink.findMany({ where: { enabled: true, country_code: country }, orderBy: { sort_order: 'asc' } }); } catch { rows = []; }
  const map = (r: any): PublicNavLink => ({ label: r.label, href: hrefFor(r.kind, r.target), external: r.kind === 'external' });
  const footer = rows.filter((r) => r.placement === 'footer').map(map);
  const main = rows.filter((r) => r.placement === 'main').map(map);
  return { footer: footer.length ? footer : FALLBACK_NAV.footer, main: main.length ? main : FALLBACK_NAV.main };
}
