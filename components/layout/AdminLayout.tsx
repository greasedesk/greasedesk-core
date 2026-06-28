/**
 * File: components/layout/AdminLayout.tsx
 * Description: Main wrapper for all authenticated pages in the /admin area.
 * Last Edited: 2025-11-13 19:35 Europe/London (FIXED - Integrated Logo)
 */
import React, { useState, useEffect } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/router';
import { signOut } from 'next-auth/react';
// ⚠️ You'll need to create a simple TopNav component later
// import TopNav from '../TopNav'; 

// 🎯 LOGO CONFIGURATION: Must point to the high-res image file in /public
const LOGO_SRC = "/greasedesk-logo-source.png";
const LOGO_DISPLAY_WIDTH = "150px"; // Suitable width for the sidebar

// Define the navigation items.
// `ready: false` items are routes whose pages aren't built yet — they're hidden from
// the nav until the slice ships. Flip ready to true when the page exists.
const navItems = [
  { name: 'Dashboard', href: '/admin/dashboard', icon: '🏠', ready: true },
  { name: 'Diary', href: '/admin/diary', icon: '🗓️', ready: true },
  { name: 'Job Cards', href: '/admin/jobcards', icon: '🛠️', ready: true },
  { name: 'Customers', href: '/admin/customers', icon: '👤', ready: false },
  { name: 'Reports', href: '/admin/reports', icon: '📊', ready: false },
  // Settings lives at the bottom of the sidebar (see below), not in the main list.
];

const visibleNavItems = navItems.filter((item) => item.ready);

interface AdminLayoutProps {
  children: React.ReactNode;
}

export default function AdminLayout({ children }: AdminLayoutProps) {
  const router = useRouter();
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
              key={item.name}
              href={item.href}
              className={`flex items-center p-3 rounded-lg transition-colors duration-200 ${
                isActive(item.href) 
                  ? 'bg-blue-600 text-white font-semibold' 
                  : 'text-slate-300 hover:bg-slate-700'
              }`}
            >
              <span className="mr-3 text-lg">{item.icon}</span>
              {item.name}
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
                Settings
            </Link>
            <button
                onClick={() => signOut({ callbackUrl: '/admin/login' })}
                className="w-full text-left p-3 rounded-lg text-sm text-slate-400 hover:text-red-400 transition"
            >
                Sign Out
            </button>
        </div>
      </aside>

      {/* --- Main Content Area --- */}
      <main className="flex-1 flex flex-col">
        {/* --- Mobile Header and Top Nav Placeholder --- */}
        <header className="bg-slate-800 border-b border-slate-700 p-4 md:hidden flex justify-between items-center sticky top-0 z-10">
            <button 
                onClick={() => setIsSidebarOpen(!isSidebarOpen)}
                className="text-white p-2 rounded-md hover:bg-slate-700 transition"
                aria-label="Toggle Menu"
            >
                ☰
            </button>
            {/* 💥 FIX: Replaced Dashboard text with Logo Component for mobile */}
            <Logo />
        </header>

        {/* --- Location top bar: each tab opens that location's diary --- */}
        {locations.length > 0 && (
          <div className="bg-slate-800 border-b border-slate-700 px-4 sm:px-6 lg:px-8 py-2 flex items-center gap-2 overflow-x-auto">
            <span className="text-xs uppercase text-slate-500 mr-1">Locations:</span>
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
                  title={`Open ${loc.site_name}'s diary`}
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
                  key={item.name}
                  href={item.href}
                  onClick={() => setIsSidebarOpen(false)}
                  className={`flex items-center p-3 rounded-lg transition-colors duration-200 ${
                    isActive(item.href) 
                      ? 'bg-blue-600 text-white font-semibold' 
                      : 'text-slate-300 hover:bg-slate-700'
                  }`}
                >
                  <span className="mr-3 text-lg">{item.icon}</span>
                  {item.name}
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
              Settings
            </Link>
            <button
              onClick={() => { setIsSidebarOpen(false); signOut({ callbackUrl: '/admin/login' }); }}
              className="w-full p-3 text-left text-sm text-slate-400 hover:text-red-400 transition"
            >
              Sign Out
            </button>
          </div>
        </div>
      )}
    </div>
  );
}