/**
 * File: components/layout/AdminLayout.tsx
 * Persistent shell for authenticated /admin pages: dark navy rail + light workspace. Mounted ONCE
 * in _app for all /admin routes (except login), so it never remounts on navigation.
 *
 * Location switching is CONTEXTUAL, not a global bar: the location-scoped sections (Diary, Job
 * Cards) expand a sub-menu of the user's accessible locations when active. The sub-menu lists
 * exactly what getVisibility allows (admin → all sites, manager → assigned, mechanic → their one),
 * so the nav itself enforces the access model. Clicking a section lands on the user's PRIMARY
 * location; the sub-menu switches. Job Cards additionally offers "All locations" (multi-site only).
 * Colours come from semantic tokens (see styles/globals.css / tailwind.config.js) — no raw slate.
 */
import React, { useState, useEffect } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/router';
import { signOut } from 'next-auth/react';
import { useTranslation } from 'next-i18next';
import BrandLogo from '@/components/BrandLogo';

type Loc = { id: string; site_name: string };
type NavItemDef = { key: string; href: string; icon: string; ready: boolean; locScope?: 'diary' | 'jobcards' };

// `key` is a stable i18n key (translated via t(`nav.${key}`)); display text lives in locale files.
// locScope marks sections that expand a per-location sub-menu.
const navItems: NavItemDef[] = [
  { key: 'dashboard', href: '/admin/dashboard', icon: '🏠', ready: true },
  { key: 'diary', href: '/admin/diary', icon: '🗓️', ready: true, locScope: 'diary' },
  { key: 'jobCards', href: '/admin/jobcards', icon: '🛠️', ready: true, locScope: 'jobcards' },
  { key: 'products', href: '/admin/products', icon: '📦', ready: true },
  { key: 'customers', href: '/admin/customers', icon: '👤', ready: false },
  { key: 'reports', href: '/admin/reports', icon: '📊', ready: false },
];
const visibleNavItems = navItems.filter((item) => item.ready);

interface AdminLayoutProps {
  children: React.ReactNode;
}

const navLink = (active: boolean) =>
  `flex items-center p-3 rounded-lg transition-colors duration-200 ${
    active ? 'bg-accent text-sidebar-active font-semibold' : 'text-sidebar-fg hover:bg-sidebar-line'
  }`;

const subLink = (active: boolean) =>
  `block px-3 py-1.5 rounded-md text-sm transition-colors ${
    active ? 'bg-accent text-white font-medium' : 'text-sidebar-muted hover:text-sidebar-active hover:bg-sidebar-line'
  }`;

// Shared nav renderer (desktop sidebar + mobile overlay). onNavigate closes the mobile menu.
function NavList({
  pathname, siteQuery, locations, primarySiteId, t, onNavigate,
}: {
  pathname: string; siteQuery: string; locations: Loc[]; primarySiteId: string | null;
  t: (k: string) => string; onNavigate?: () => void;
}) {
  return (
    <>
      {visibleNavItems.map((item) => {
        const active = pathname === item.href || pathname.startsWith(item.href + '/');
        const showSub = !!item.locScope && active && locations.length > 0;
        // Which location the current view is showing (for highlight). "All" only applies to Job Cards.
        const isAll = item.locScope === 'jobcards' && siteQuery === 'all';
        const selected = isAll ? '' : (siteQuery && siteQuery !== 'all' ? siteQuery : (primarySiteId ?? ''));
        return (
          <div key={item.key}>
            <Link href={item.href} onClick={onNavigate} className={navLink(active)}>
              <span className="mr-3 text-lg">{item.icon}</span>
              {t(`nav.${item.key}`)}
            </Link>
            {showSub && (
              <div className="mt-1 mb-1 ml-4 pl-3 border-l border-sidebar-line space-y-0.5">
                {item.locScope === 'jobcards' && locations.length > 1 && (
                  <Link href={`${item.href}?site=all`} onClick={onNavigate} className={subLink(isAll)}>
                    {t('nav.allLocations')}
                  </Link>
                )}
                {locations.map((loc) => (
                  <Link key={loc.id} href={`${item.href}?site=${loc.id}`} onClick={onNavigate} className={subLink(loc.id === selected)}>
                    {loc.site_name}
                  </Link>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </>
  );
}

export default function AdminLayout({ children }: AdminLayoutProps) {
  const router = useRouter();
  const { t } = useTranslation('common');
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);
  const [locations, setLocations] = useState<Loc[]>([]);
  const [primarySiteId, setPrimarySiteId] = useState<string | null>(null);

  // Fetches ONCE for the whole admin session (this shell is persistent — never remounts on nav).
  useEffect(() => {
    let active = true;
    fetch('/api/locations')
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (active && d) {
          setLocations(d.locations || []);
          setPrimarySiteId(d.primarySiteId ?? null);
        }
      })
      .catch(() => {});
    return () => { active = false; };
  }, []);

  const siteQuery = typeof router.query.site === 'string' ? router.query.site : '';

  return (
    <div className="min-h-screen bg-content text-ink flex">
      {/* --- Desktop sidebar (dark rail) --- */}
      <aside className="hidden md:block w-64 bg-sidebar border-r border-sidebar-line p-4 sticky top-0 h-screen overflow-y-auto">
        <div className="mb-8"><BrandLogo /></div>

        <nav className="space-y-2">
          <NavList pathname={router.pathname} siteQuery={siteQuery} locations={locations} primarySiteId={primarySiteId} t={t} />
        </nav>

        {/* Settings (cog) sits at the bottom, directly above Sign Out. */}
        <div className="absolute bottom-4 left-0 w-full px-4 space-y-1">
          <Link href="/admin/settings" className={navLink(router.pathname.startsWith('/admin/settings'))}>
            <span className="mr-3 text-lg">⚙️</span>
            {t('nav.settings')}
          </Link>
          <button
            onClick={() => signOut({ callbackUrl: '/admin/login' })}
            className="w-full text-left p-3 rounded-lg text-sm text-sidebar-muted hover:text-sidebar-active transition"
          >
            {t('nav.signOut')}
          </button>
        </div>
      </aside>

      {/* --- Main content area (light workspace) --- */}
      <main className="flex-1 flex flex-col min-w-0 bg-content">
        {/* Mobile header */}
        {/* Exact h-14 (56px): the job-card tab strip sticks at top-14 directly beneath it. */}
        <header className="bg-sidebar border-b border-sidebar-line h-14 px-3 md:hidden flex justify-between items-center sticky top-0 z-30">
          <button
            onClick={() => setIsSidebarOpen(!isSidebarOpen)}
            className="text-sidebar-active w-11 h-11 flex items-center justify-center text-2xl rounded-md hover:bg-sidebar-line transition"
            aria-label={t('nav.toggleMenu')}
          >
            ☰
          </button>
          <BrandLogo width={72} slim />
        </header>

        {/* Page content */}
        <div className="flex-1 p-4 sm:p-6 lg:p-8">{children}</div>
      </main>

      {/* --- Mobile menu overlay --- */}
      {isSidebarOpen && (
        <div className="fixed inset-0 bg-black/50 z-20 md:hidden" onClick={() => setIsSidebarOpen(false)}>
          <div className="w-64 bg-sidebar h-full p-4 overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            <div className="mb-8"><BrandLogo /></div>
            <nav className="space-y-2">
              <NavList
                pathname={router.pathname} siteQuery={siteQuery} locations={locations} primarySiteId={primarySiteId}
                t={t} onNavigate={() => setIsSidebarOpen(false)}
              />
            </nav>
            <Link href="/admin/settings" onClick={() => setIsSidebarOpen(false)} className={`mt-4 ${navLink(router.pathname.startsWith('/admin/settings'))}`}>
              <span className="mr-3 text-lg">⚙️</span>
              {t('nav.settings')}
            </Link>
            <button
              onClick={() => { setIsSidebarOpen(false); signOut({ callbackUrl: '/admin/login' }); }}
              className="w-full p-3 text-left text-sm text-sidebar-muted hover:text-sidebar-active transition"
            >
              {t('nav.signOut')}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
