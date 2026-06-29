/**
 * File: components/layout/SettingsLayout.tsx
 * Wraps AdminLayout and renders the Settings sub-navigation. Admin-only tabs are hidden from
 * STANDARD users (pass isAdmin). Page-level access is still enforced by requireAdminPage on each
 * admin-only page's getServerSideProps — this just keeps the nav honest.
 */
import React from 'react';
import Link from 'next/link';
import { useRouter } from 'next/router';
import AdminLayout from '@/components/layout/AdminLayout';

const SUBNAV: Array<{ name: string; href: string; adminOnly?: boolean }> = [
  { name: 'Locations & Resources', href: '/admin/settings/locations' },
  { name: 'Users', href: '/admin/settings/users', adminOnly: true },
  { name: 'Financial', href: '/admin/settings/financial', adminOnly: true },
  { name: 'Licences & Subscriptions', href: '/admin/settings/licences', adminOnly: true },
  { name: 'Profile', href: '/admin/settings/profile' },
];

export default function SettingsLayout({ isAdmin = false, children }: { isAdmin?: boolean; children: React.ReactNode }) {
  const router = useRouter();
  const tabs = SUBNAV.filter((s) => !s.adminOnly || isAdmin);
  return (
    <AdminLayout>
      <h1 className="text-3xl font-bold text-white mb-4">Settings</h1>
      <div className="flex flex-wrap gap-1 border-b border-slate-700 mb-6">
        {tabs.map((s) => {
          const active = router.pathname === s.href;
          return (
            <Link
              key={s.href}
              href={s.href}
              className={`px-4 py-2 text-sm rounded-t-lg transition-colors ${
                active
                  ? 'bg-slate-800 text-white border-b-2 border-blue-500 font-semibold'
                  : 'text-slate-400 hover:text-white hover:bg-slate-800/50'
              }`}
            >
              {s.name}
            </Link>
          );
        })}
      </div>
      {children}
    </AdminLayout>
  );
}
