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

// adminOnly → ADMIN/owner only; managerOk → ADMIN or SITE_MANAGER; neither → everyone.
const SUBNAV: Array<{ name: string; href: string; adminOnly?: boolean; managerOk?: boolean }> = [
  { name: 'Locations & Resources', href: '/admin/settings/locations', managerOk: true },
  { name: 'Users', href: '/admin/settings/users', managerOk: true },
  { name: 'Financial', href: '/admin/settings/financial', adminOnly: true },
  { name: 'Headcount', href: '/admin/settings/headcount', adminOnly: true },
  { name: 'Overheads', href: '/admin/settings/overheads', adminOnly: true },
  { name: 'Permissions', href: '/admin/settings/permissions', adminOnly: true },
  { name: 'Licences & Subscriptions', href: '/admin/settings/licences', adminOnly: true },
  { name: 'Profile', href: '/admin/settings/profile' },
];

export default function SettingsLayout({ isAdmin = false, isManager = false, children }: { isAdmin?: boolean; isManager?: boolean; children: React.ReactNode }) {
  const router = useRouter();
  const tabs = SUBNAV.filter((s) => {
    if (s.adminOnly) return isAdmin;
    if (s.managerOk) return isAdmin || isManager;
    return true;
  });
  return (
    <AdminLayout>
      <h1 className="text-3xl font-bold text-ink mb-4">Settings</h1>
      <div className="flex flex-wrap gap-1 border-b border-line mb-6">
        {tabs.map((s) => {
          const active = router.pathname === s.href;
          return (
            <Link
              key={s.href}
              href={s.href}
              className={`px-4 py-2 text-sm rounded-t-lg transition-colors ${
                active
                  ? 'bg-surface text-ink border-b-2 border-accent font-semibold'
                  : 'text-muted hover:text-ink hover:bg-surface-muted'
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
