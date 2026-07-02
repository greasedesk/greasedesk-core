/**
 * File: components/layout/SettingsLayout.tsx
 * Renders the two-tier Settings navigation INSIDE the persistent admin shell (AdminLayout is
 * mounted once in _app for /admin routes — this no longer wraps it):
 *   Top tabs:  Locations & Resources · Users · Company Profile · Licence & Subscriptions
 *   Sub-tabs:  contextual (Users → roster/permissions; Company Profile → account/company/…).
 * Nav flags only HIDE tabs; page-level getServerSideProps still enforces gating (requireAdminPage /
 * requireSiteManagerPage). The Users top-tab href varies by role: managers/admins land on the
 * roster, a STANDARD user lands on their own detail (pass selfUserId).
 */
import React from 'react';
import Link from 'next/link';
import { useRouter } from 'next/router';

// Gating: adminOnly → ADMIN/owner; managerOk → ADMIN or SITE_MANAGER; neither → everyone.
type Gate = { adminOnly?: boolean; managerOk?: boolean };
type SubTab = Gate & { name: string; href: string };
type TopTab = Gate & { name: string; key: string; href: string; match: string[]; subtabs?: SubTab[] };

const TABS: TopTab[] = [
  {
    name: 'Locations & Resources', key: 'locations', href: '/admin/settings/locations', managerOk: true,
    match: ['/admin/settings/locations'],
  },
  {
    // Visible to everyone; href is resolved per-role in hrefFor (roster vs own detail). Both the
    // roster (/users) and Permissions (/permissions) live under this tab, so BOTH must match here —
    // otherwise the Permissions page finds no active top tab and the sub-tab bar disappears.
    name: 'Users', key: 'users', href: '/admin/settings/users',
    match: ['/admin/settings/users', '/admin/settings/permissions'],
    subtabs: [
      { name: 'Users', href: '/admin/settings/users', managerOk: true },
      { name: 'Permissions', href: '/admin/settings/permissions', adminOnly: true },
    ],
  },
  {
    name: 'Company Profile', key: 'company', href: '/admin/settings/company/account', adminOnly: true,
    match: ['/admin/settings/company', '/admin/settings/financial', '/admin/settings/headcount', '/admin/settings/overheads'],
    subtabs: [
      { name: 'Account Details', href: '/admin/settings/company/account', adminOnly: true },
      { name: 'Company Details', href: '/admin/settings/company/details', adminOnly: true },
      { name: 'Financial', href: '/admin/settings/financial', adminOnly: true },
      { name: 'Headcount', href: '/admin/settings/headcount', adminOnly: true },
      { name: 'Overheads', href: '/admin/settings/overheads', adminOnly: true },
    ],
  },
  {
    name: 'Licence & Subscriptions', key: 'licence', href: '/admin/settings/licences', adminOnly: true,
    match: ['/admin/settings/licences'],
  },
];

type Props = { isAdmin?: boolean; isManager?: boolean; selfUserId?: string; children: React.ReactNode };

export default function SettingsLayout({ isAdmin = false, isManager = false, selfUserId, children }: Props) {
  const router = useRouter();
  const path = router.pathname; // e.g. /admin/settings/users/[id]
  const canSee = (g: Gate) => (g.adminOnly ? isAdmin : g.managerOk ? isAdmin || isManager : true);

  const top = TABS.filter(canSee);
  const active = TABS.find((t) => t.match.some((m) => path === m || path.startsWith(m + '/')));
  // Users top-tab: managers/admins → roster; a STANDARD user → their own detail.
  const hrefFor = (t: TopTab) =>
    t.key === 'users' && !(isAdmin || isManager) && selfUserId ? `/admin/settings/users/${selfUserId}` : t.href;
  const subtabs = (active?.subtabs ?? []).filter(canSee);

  const tabCls = (on: boolean) =>
    `px-4 py-2 text-sm rounded-t-lg transition-colors ${
      on ? 'bg-surface text-ink border-b-2 border-accent font-semibold' : 'text-muted hover:text-ink hover:bg-surface-muted'
    }`;
  const subCls = (on: boolean) =>
    `px-3 py-1.5 text-sm rounded-lg transition-colors ${
      on ? 'bg-accent-soft text-accent font-semibold' : 'text-muted hover:text-ink hover:bg-surface-muted'
    }`;

  // NOTE: no AdminLayout wrapper here — the admin shell is mounted once in _app for all /admin
  // routes (persistent), so this renders only the settings chrome (title + two-tier nav) inside
  // that stable shell. Switching tabs swaps this content but never remounts the shell/locations bar.
  return (
    <>
      <h1 className="text-3xl font-bold text-ink mb-4">Settings</h1>
      <div className="flex flex-wrap gap-1 border-b border-line mb-4">
        {top.map((t) => (
          <Link key={t.key} href={hrefFor(t)} className={tabCls(active?.key === t.key)}>{t.name}</Link>
        ))}
      </div>
      {subtabs.length > 0 && (
        <div className="flex flex-wrap gap-1 mb-6">
          {subtabs.map((s) => {
            const on = path === s.href || path.startsWith(s.href + '/');
            return <Link key={s.href} href={s.href} className={subCls(on)}>{s.name}</Link>;
          })}
        </div>
      )}
      {children}
    </>
  );
}
