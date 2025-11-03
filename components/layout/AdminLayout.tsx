/**
 * File: components/layout/AdminLayout.tsx
 * Description: Main wrapper for all authenticated pages in the /admin area.
 */
import React, { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/router';
// ⚠️ You'll need to create a simple TopNav component later
// import TopNav from '../TopNav'; 

// Define the navigation items
const navItems = [
  { name: 'Dashboard', href: '/admin/dashboard', icon: '🏠' },
  { name: 'Bookings', href: '/admin/bookings', icon: '🗓️' },
  { name: 'Job Cards', href: '/admin/jobcards', icon: '🛠️' },
  { name: 'Customers', href: '/admin/customers', icon: '👤' },
  { name: 'Reports', href: '/admin/reports', icon: '📊' },
  { name: 'Settings', href: '/admin/settings', icon: '⚙️' },
];

interface AdminLayoutProps {
  children: React.ReactNode;
}

export default function AdminLayout({ children }: AdminLayoutProps) {
  const router = useRouter();
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);

  const isActive = (href: string) => router.pathname === href;

  return (
    <div className="min-h-screen bg-slate-900 text-slate-100 flex">
      {/* --- Desktop Sidebar (Fixed) --- */}
      <aside 
        className="hidden md:block w-64 bg-slate-800 border-r border-slate-700 p-4 sticky top-0 h-screen overflow-y-auto shadow-xl"
      >
        <div className="text-2xl font-black text-blue-400 mb-8">
          GreaseDesk
        </div>
        <nav className="space-y-2">
          {navItems.map((item) => (
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
        
        {/* Future Site Switcher / Logout can go here */}
        <div className="absolute bottom-4 w-full pr-8">
            <button className="w-full py-2 text-sm text-slate-400 hover:text-red-400 transition">
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
            <span className="text-xl font-bold text-blue-400">Dashboard</span>
        </header>

        {/* --- Page Content (The children prop) --- */}
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
            <div className="text-2xl font-black text-blue-400 mb-8">GreaseDesk</div>
            <nav className="space-y-2">
              {navItems.map((item) => (
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
          </div>
        </div>
      )}
    </div>
  );
}