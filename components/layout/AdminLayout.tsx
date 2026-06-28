/**
 * File: components/layout/AdminLayout.tsx
 * Description: Main wrapper for all authenticated pages in the /admin area.
 * Last Edited: 2025-11-13 19:35 Europe/London (FIXED - Integrated Logo)
 */
import React, { useState } from 'react';
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
  { name: 'Bookings', href: '/admin/bookings', icon: '🗓️', ready: false },
  { name: 'Job Cards', href: '/admin/jobcards', icon: '🛠️', ready: true },
  { name: 'Profit Centres', href: '/admin/profit-centres', icon: '🏭', ready: true },
  { name: 'Customers', href: '/admin/customers', icon: '👤', ready: false },
  { name: 'Reports', href: '/admin/reports', icon: '📊', ready: false },
  { name: 'Settings', href: '/admin/settings', icon: '⚙️', ready: true },
];

const visibleNavItems = navItems.filter((item) => item.ready);

interface AdminLayoutProps {
  children: React.ReactNode;
}

export default function AdminLayout({ children }: AdminLayoutProps) {
  const router = useRouter();
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);

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
        
        {/* Future Site Switcher can go here */}
        <div className="absolute bottom-4 w-full pr-8">
            <button
                onClick={() => signOut({ callbackUrl: '/admin/login' })}
                className="w-full py-2 text-sm text-slate-400 hover:text-red-400 transition"
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
            <button
              onClick={() => { setIsSidebarOpen(false); signOut({ callbackUrl: '/admin/login' }); }}
              className="w-full mt-4 p-3 text-left text-sm text-slate-400 hover:text-red-400 transition"
            >
              Sign Out
            </button>
          </div>
        </div>
      )}
    </div>
  );
}