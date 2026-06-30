/**
 * File: components/layout/AdminLayout.tsx
 * Description: Main wrapper for all authenticated pages in the /admin area.
 * Last Edited: 2025-11-13 19:35 Europe/London (FIXED - Integrated Logo)
 */
import React, { useState, useEffect } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/router';
import { signOut } from 'next-auth/react';
import { useTranslation } from 'next-i18next';
// ⚠️ You'll need to create a simple TopNav component later
// import TopNav from '../TopNav'; 

// 🎯 LOGO CONFIGURATION: Must point to the high-res image file in /public
const LOGO_SRC = "/greasedesk-logo-source.png";
const LOGO_DISPLAY_WIDTH = "150px"; // Suitable width for the sidebar

// Define the navigation items.
// `ready: false` items are routes whose pages aren't built yet — they're hidden from
// the nav until the slice ships. Flip ready to true when the page exists.
// `key` is a stable i18n key (translated via t(`nav.${key}`)); display text lives in locale files.
const navItems = [
  { key: 'dashboard', href: '/admin/dashboard', icon: '🏠', ready: true },
  { key: 'diary', href: '/admin/diary', icon: '🗓️', ready: true },
  { key: 'jobCards', href: '/admin/jobcards', icon: '🛠️', ready: true },
  { key: 'customers', href: '/admin/customers', icon: '👤', ready: false },
  { key: 'reports', href: '/admin/reports', icon: '📊', ready: false },
  // Settings lives at the bottom of the sidebar (see below), not in the main list.
];

const visibleNavItems = navItems.filter((item) => item.ready);

interface AdminLayoutProps {
  children: React.ReactNode;
}

export default function AdminLayout({ children }: AdminLayoutProps) {
  const router = useRouter();
  const { t } = useTranslation('common');
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);
  const [locations, setLocations] = useState<Array<{ id: string; site_name: string }>>([]);
  const [currentSiteId, setCurrentSiteId] = useState<string | null>(null);

  // Top-bar location navigation: the group's Sites (locations) + the current one.
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
    return () => {
      active = false;
    };
  }, []);

  const isActive = (href: string) => router.pathname === href;

  // Component to render the logo
  const Logo = () => (
    <Link href="/admin/dashboard">
        <img
            src={LOGO_SRC}
            alt="GreaseDesk Logo"
            // Use style to scale the large source image down crisply
            style={{ width: LOGO_DISPLAY_WIDTH, height: 'auto' }} 
            className="mb-8"
        />
    </Link>
  );

  return (
    <div className="min-h-screen bg-slate-900 text-slate-100 flex">
      {/* --- Desktop Sidebar (Fixed) --- */}
      <aside 
        className="hidden md:block w-64 bg-slate-800 border-r border-slate-700 p-4 sticky top-0 h-screen overflow-y-auto shadow-xl"
      >
        {/* 💥 FIX: Replaced text with Logo Component */}
        <Logo /> 
        
        <nav className="space-y-2">
          {visibleNavItems.map((item) => (
            <Link
              key={item.key}
              href={item.href}
              className={`flex items-center p-3 rounded-lg transition-colors duration-200 ${
                isActive(item.href) 
                  ? 'bg-blue-600 text-white font-semibold' 
                  : 'text-slate-300 hover:bg-slate-700'
              }`}
            >
              <span className="mr-3 text-lg">{item.icon}</span>
              {t(`nav.${item.key}`)}
            </Link>
          ))}
        </nav>
        
        {/* Settings (cog) sits at the bottom, directly above Sign Out. */}
        <div className="absolute bottom-4 left-0 w-full px-4 space-y-1">
            <Link
                href="/admin/settings"
                className={`flex items-center p-3 rounded-lg transition-colors duration-200 ${
                  router.pathname.startsWith('/admin/settings')
                    ? 'bg-blue-600 text-white font-semibold'
                    : 'text-slate-300 hover:bg-slate-700'
                }`}
            >
                <span className="mr-3 text-lg">⚙️</span>
                {t('nav.settings')}
            </Link>
            <button
                onClick={() => signOut({ callbackUrl: '/admin/login' })}
                className="w-full text-left p-3 rounded-lg text-sm text-slate-400 hover:text-red-400 transition"
            >
                {t('nav.signOut')}
            </button>
        </div>
      </aside>

      {/* --- Main Content Area --- */}
      {/* min-w-0 lets this flex child shrink so wide content (e.g. the diary grid) scrolls
          within its own overflow-x container instead of forcing page-wide horizontal scroll
          (which would push the sticky sidebar off-screen). */}
      <main className="flex-1 flex flex-col min-w-0">
        {/* --- Mobile Header and Top Nav Placeholder --- */}
        <header className="bg-slate-800 border-b border-slate-700 p-4 md:hidden flex justify-between items-center sticky top-0 z-10">
            <button 
                onClick={() => setIsSidebarOpen(!isSidebarOpen)}
                className="text-white p-2 rounded-md hover:bg-slate-700 transition"
                aria-label={t('nav.toggleMenu')}
            >
                ☰
            </button>
            {/* 💥 FIX: Replaced Dashboard text with Logo Component for mobile */}
            <Logo />
        </header>

        {/* --- Location top bar: each tab opens that location's diary --- */}
        {locations.length > 0 && (
          <div className="bg-slate-800 border-b border-slate-700 px-4 sm:px-6 lg:px-8 py-2 flex items-center gap-2 overflow-x-auto">
            <span className="text-xs uppercase text-slate-500 mr-1">{t('nav.locationsLabel')}</span>
            {locations.map((loc) => {
              // On the diary, the active tab follows ?site; elsewhere, the session's site.
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
                      ? 'bg-blue-600 text-white border-blue-400'
                      : 'bg-slate-700 text-slate-300 border-slate-600 hover:bg-slate-600'
                  }`}
                  title={t('nav.openDiary', { name: loc.site_name })}
                >
                  {loc.site_name}
                </Link>
              );
            })}
          </div>
        )}

        {/* --- Page Content (The children prop..) --- */}
        <div className="flex-1 p-4 sm:p-6 lg:p-8">
          {children}
        </div>
      </main>

      {/* --- Mobile Menu Overlay (Conditional Rendering) --- */}
      {isSidebarOpen && (
        <div 
          className="fixed inset-0 bg-slate-900 bg-opacity-70 z-20 md:hidden" 
          onClick={() => setIsSidebarOpen(false)}
        >
          {/* Mobile Sidebar Content */}
          <div className="w-64 bg-slate-800 h-full p-4 shadow-2xl" onClick={(e) => e.stopPropagation()}>
            {/* 💥 FIX: Replaced text with Logo Component for mobile menu */}
            <Logo />
            <nav className="space-y-2">
              {visibleNavItems.map((item) => (
                <Link
                  key={item.key}
                  href={item.href}
                  onClick={() => setIsSidebarOpen(false)}
                  className={`flex items-center p-3 rounded-lg transition-colors duration-200 ${
                    isActive(item.href)
                      ? 'bg-blue-600 text-white font-semibold'
                      : 'text-slate-300 hover:bg-slate-700'
                  }`}
                >
                  <span className="mr-3 text-lg">{item.icon}</span>
                  {t(`nav.${item.key}`)}
                </Link>
              ))}
            </nav>
            <Link
              href="/admin/settings"
              onClick={() => setIsSidebarOpen(false)}
              className={`flex items-center mt-4 p-3 rounded-lg transition-colors duration-200 ${
                router.pathname.startsWith('/admin/settings')
                  ? 'bg-blue-600 text-white font-semibold'
                  : 'text-slate-300 hover:bg-slate-700'
              }`}
            >
              <span className="mr-3 text-lg">⚙️</span>
              {t('nav.settings')}
            </Link>
            <button
              onClick={() => { setIsSidebarOpen(false); signOut({ callbackUrl: '/admin/login' }); }}
              className="w-full p-3 text-left text-sm text-slate-400 hover:text-red-400 transition"
            >
              {t('nav.signOut')}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}