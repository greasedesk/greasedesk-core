/**
 * File: components/layout/AdminLayout.tsx
 * Wrapper for all authenticated /admin pages: dark navy rail + light workspace. Colours come from
 * semantic tokens (see styles/globals.css / tailwind.config.js) — no raw slate/blue here.
 */
import React, { useState, useEffect } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/router';
import { signOut } from 'next-auth/react';
import { useTranslation } from 'next-i18next';
import BrandLogo from '@/components/BrandLogo';

// `key` is a stable i18n key (translated via t(`nav.${key}`)); display text lives in locale files.
const navItems = [
  { key: 'dashboard', href: '/admin/dashboard', icon: '🏠', ready: true },
  { key: 'diary', href: '/admin/diary', icon: '🗓️', ready: true },
  { key: 'jobCards', href: '/admin/jobcards', icon: '🛠️', ready: true },
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

export default function AdminLayout({ children }: AdminLayoutProps) {
  const router = useRouter();
  const { t } = useTranslation('common');
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);
  const [locations, setLocations] = useState<Array<{ id: string; site_name: string }>>([]);
  const [currentSiteId, setCurrentSiteId] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    fetch('/api/locations')
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (active && d) {
          setLocations(d.locations || []);
          setCurrentSiteId(d.currentSiteId || null);
        }
      })
      .catch(() => {});
    return () => { active = false; };
  }, []);

  const isActive = (href: string) => router.pathname === href;

  return (
    <div className="min-h-screen bg-content text-ink flex">
      {/* --- Desktop sidebar (dark rail) --- */}
      <aside className="hidden md:block w-64 bg-sidebar border-r border-sidebar-line p-4 sticky top-0 h-screen overflow-y-auto">
        <div className="mb-8"><BrandLogo /></div>

        <nav className="space-y-2">
          {visibleNavItems.map((item) => (
            <Link key={item.key} href={item.href} className={navLink(isActive(item.href))}>
              <span className="mr-3 text-lg">{item.icon}</span>
              {t(`nav.${item.key}`)}
            </Link>
          ))}
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
        <header className="bg-sidebar border-b border-sidebar-line p-4 md:hidden flex justify-between items-center sticky top-0 z-10">
          <button
            onClick={() => setIsSidebarOpen(!isSidebarOpen)}
            className="text-sidebar-active p-2 rounded-md hover:bg-sidebar-line transition"
            aria-label={t('nav.toggleMenu')}
          >
            ☰
          </button>
          <BrandLogo width={120} />
        </header>

        {/* Location top bar — PERSISTENT: this shell is mounted once (via getLayout) and reconciled
            across navigations, so it never remounts/refetches. Always rendered with a reserved
            height so it never appears/disappears (no layout shift, no flicker on tab switch). */}
        <div className="bg-surface border-b border-line px-4 sm:px-6 lg:px-8 py-2 flex items-center gap-2 overflow-x-auto min-h-[41px]">
          <span className="text-xs uppercase text-muted mr-1">{t('nav.locationsLabel')}</span>
          {locations.map((loc) => {
              const selected =
                router.pathname === '/admin/diary'
                  ? (router.query.site as string) ?? currentSiteId
                  : currentSiteId;
              const active = loc.id === selected;
              return (
                <Link
                  key={loc.id}
                  href={`/admin/diary?site=${loc.id}`}
                  className={`text-sm px-3 py-1 rounded-lg border whitespace-nowrap transition-colors ${
                    active
                      ? 'bg-accent text-white border-accent'
                      : 'bg-surface-muted text-muted border-line hover:bg-accent-soft'
                  }`}
                  title={t('nav.openDiary', { name: loc.site_name })}
                >
                  {loc.site_name}
                </Link>
              );
            })}
        </div>

        {/* Page content */}
        <div className="flex-1 p-4 sm:p-6 lg:p-8">{children}</div>
      </main>

      {/* --- Mobile menu overlay --- */}
      {isSidebarOpen && (
        <div className="fixed inset-0 bg-black/50 z-20 md:hidden" onClick={() => setIsSidebarOpen(false)}>
          <div className="w-64 bg-sidebar h-full p-4" onClick={(e) => e.stopPropagation()}>
            <div className="mb-8"><BrandLogo /></div>
            <nav className="space-y-2">
              {visibleNavItems.map((item) => (
                <Link key={item.key} href={item.href} onClick={() => setIsSidebarOpen(false)} className={navLink(isActive(item.href))}>
                  <span className="mr-3 text-lg">{item.icon}</span>
                  {t(`nav.${item.key}`)}
                </Link>
              ))}
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
