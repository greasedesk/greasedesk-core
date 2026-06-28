/**
 * File: components/layout/SettingsLayout.tsx
 * Wraps AdminLayout and renders the Settings sub-navigation:
 * Financial · Locations & Resources · Users · Licences & Subscriptions.
 */
import React from 'react';
import Link from 'next/link';
import { useRouter } from 'next/router';
import AdminLayout from '@/components/layout/AdminLayout';

const SUBNAV = [
  { name: 'Financial', href: '/admin/settings/financial' },
  { name: 'Locations & Resources', href: '/admin/settings/locations' },
  { name: 'Users', href: '/admin/settings/users' },
  { name: 'Licences & Subscriptions', href: '/admin/settings/licences' },
];

export default function SettingsLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  return (
    <AdminLayout>
      <h1 className="text-3xl font-bold text-white mb-4">Settings</h1>
      <div className="flex flex-wrap gap-1 border-b border-slate-700 mb-6">
        {SUBNAV.map((s) => {
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
