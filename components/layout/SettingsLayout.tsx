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
/** A pointer to somewhere OUTSIDE Settings. Rendered as a line of text, never as a tab: a tab that
 *  navigates out of Settings looks like part of Settings and isn't, which is disorienting. */
type Pointer = { text: string; linkText: string; href: string };
type TopTab = Gate & { name: string; key: string; href: string; match: string[]; subtabs?: SubTab[]; pointer?: Pointer };

const TABS: TopTab[] = [
  /**
   * ── MY ACCOUNT — EVERY ROLE, ALWAYS FIRST ─────────────────────────────────────────────────────
   * Your own password, login email, sessions and mobile number. The href is resolved per-user in
   * hrefFor; the placeholder below is never navigated to.
   *
   * It exists because the page it points at was reachable only by accident. An ADMIN found their
   * own record by spotting themselves in a roster meant for managing OTHER people; a STANDARD user
   * got there because the Users tab was quietly rewritten for them; and a SITE_MANAGER could not
   * get there AT ALL — the roster is scoped to STANDARD users so they are absent from it, and the
   * rewrite deliberately excluded managers because they "get the roster". Between those two rules
   * a manager had no route to their own account page, which is where they change their password.
   *
   * Naming it also fixes a smaller thing: "my details" and "managing my staff" are different jobs,
   * and one tab called Users was doing both.
   */
  {
    name: 'My account', key: 'account', href: '/admin/settings/users',
    match: [], // never matches by path — see accountActive below; the Users tab owns /users/*
  },
  {
    name: 'Locations & Resources', key: 'locations', href: '/admin/settings/locations', managerOk: true,
    match: ['/admin/settings/locations'],
  },
  {
    // Managing OTHER people. Both the roster (/users) and Permissions (/permissions) live under this
    // tab, so BOTH must match here — otherwise the Permissions page finds no active top tab and the
    // sub-tab bar disappears. A STANDARD user has nobody to manage, so it is hidden from them.
    name: 'Users', key: 'users', href: '/admin/settings/users', managerOk: true,
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
      // Headcount was a TAB here that redirected straight to /admin/hr — it looked like part of
      // Settings and threw you out of it. Now a pointer line where the tab sat. The
      // /admin/settings/headcount route stays as a redirect so existing deep links survive.
      { name: 'Overheads', href: '/admin/settings/overheads', adminOnly: true },
    ],
    pointer: { text: 'Staff records, headcount and employment history live under', linkText: 'HR', href: '/admin/hr' },
  },
  {
    name: 'Invoicing', key: 'invoicing', href: '/admin/settings/invoicing', adminOnly: true,
    match: ['/admin/settings/invoicing'],
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

  // 'My account' is dropped when we do not know who "self" is, rather than rendering a tab that
  // cannot resolve a destination.
  const top = TABS.filter(canSee).filter((t) => t.key !== 'account' || !!selfUserId);
  // MY ACCOUNT WINS ON THE SELF RECORD. /admin/settings/users/<self> is matched by the Users tab's
  // prefix too, so without this the manager who just clicked "My account" would see "Users"
  // highlighted and the roster's sub-tabs — told they are somewhere they are not.
  const accountActive = !!selfUserId && path === `/admin/settings/users/${selfUserId}`;
  const active = accountActive
    ? TABS.find((t) => t.key === 'account')
    : TABS.find((t) => t.match.some((m) => path === m || path.startsWith(m + '/')));
  const hrefFor = (t: TopTab) =>
    t.key === 'account' && selfUserId ? `/admin/settings/users/${selfUserId}` : t.href;
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
        <div className="flex flex-wrap gap-1 mb-2">
          {subtabs.map((s) => {
            const on = path === s.href || path.startsWith(s.href + '/');
            return <Link key={s.href} href={s.href} className={subCls(on)}>{s.name}</Link>;
          })}
        </div>
      )}
      {active?.pointer && (
        <p className="text-xs text-muted mb-6" data-testid="settings-pointer">
          {active.pointer.text}{' '}
          <Link href={active.pointer.href} className="text-accent hover:underline">{active.pointer.linkText}</Link>.
        </p>
      )}
      {subtabs.length > 0 && !active?.pointer && <div className="mb-4" />}
      {children}
    </>
  );
}
