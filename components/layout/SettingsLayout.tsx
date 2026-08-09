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
import { useSession } from 'next-auth/react';
import { useRouter } from 'next/router';

// Gating: adminOnly → ADMIN/owner; managerOk → ADMIN or SITE_MANAGER; neither → everyone.
type Gate = { adminOnly?: boolean; managerOk?: boolean };
type SubTab = Gate & { name: string; href: string };
/** A pointer to somewhere OUTSIDE Settings. Rendered as a line of text, never as a tab: a tab that
 *  navigates out of Settings looks like part of Settings and isn't, which is disorienting. */
type Pointer = { text: string; linkText: string; href: string };
type TopTab = Gate & { name: string; key: string; href: string; match: string[]; subtabs?: SubTab[]; pointer?: Pointer };

const TABS: TopTab[] = [
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
  /**
   * ── ACCOUNT — WHO YOU ARE, WHAT YOU PAY, WHO LOOKS AFTER YOU ──────────────────────────────────
   * Was "Licence & Subscriptions", which described one of the three things now under it.
   *
   * MY ACCOUNT IS HERE, AND VISIBLE TO EVERY ROLE. The page it points at existed already but was
   * reachable only by accident: an ADMIN found their own record by spotting themselves in a roster
   * built for managing OTHER people, a STANDARD user got there because the Users tab was quietly
   * rewritten for them, and a SITE_MANAGER could not get there AT ALL — the roster is scoped to
   * STANDARD users so managers are absent from it, and the rewrite excluded managers on the grounds
   * that they "get the roster". Between those two rules a manager had no route to the page where
   * they change their own password.
   *
   * The top tab is therefore NOT adminOnly; the sub-tabs carry their own gates, so a manager or
   * mechanic sees Account with one entry in it and admins see all three.
   */
  {
    name: 'Account', key: 'account', href: '/admin/settings/users',
    match: ['/admin/settings/licences'],
    subtabs: [
      // href resolved per-user in hrefFor — the placeholder is never navigated to.
      { name: 'My Account', href: '/admin/settings/users' },
      { name: 'Licence & Subscriptions', href: '/admin/settings/licences', adminOnly: true },
      // My Rep lands here once its content is agreed. Deliberately absent rather than stubbed: a
      // sub-tab pointing at a page that does not exist is a 404 with a friendly label on it.
    ],
  },
];

/** selfUserId is an OVERRIDE; the session supplies it everywhere else. */
type Props = { isAdmin?: boolean; isManager?: boolean; selfUserId?: string; children: React.ReactNode };

export default function SettingsLayout({ isAdmin = false, isManager = false, selfUserId, children }: Props) {
  // ── WHO IS "SELF", ON EVERY SETTINGS PAGE ────────────────────────────────────────────────────
  // Only users/[id] ever passed selfUserId, so anywhere else the Account tab would have vanished —
  // a manager on Locations would lose the only route to their own password. Read from the session
  // instead of threading a prop through ten getServerSideProps: the layout is the thing that needs
  // it, and the session already carries it on every authenticated page.
  const { data: session } = useSession();
  const selfId = selfUserId ?? ((session?.user as any)?.id as string | undefined);
  const router = useRouter();
  // ── RESOLVED URL, NOT THE ROUTE PATTERN ──────────────────────────────────────────────────────
  // This was router.pathname, which yields '/admin/settings/users/[id]' — a literal that can never
  // equal '/admin/settings/users/<uuid>'. Everything comparing against a per-user href therefore
  // failed silently: on a manager's own account page the Account tab did not register as active, so
  // `active` was undefined and the ENTIRE sub-tab row disappeared. asPath is what the browser is
  // actually showing, and the static match[] prefixes hold under it unchanged.
  const path = (router.asPath || router.pathname).split('?')[0].split('#')[0];
  const canSee = (g: Gate) => (g.adminOnly ? isAdmin : g.managerOk ? isAdmin || isManager : true);

  // 'My account' is dropped when we do not know who "self" is, rather than rendering a tab that
  // cannot resolve a destination.
  const top = TABS.filter(canSee).filter((t) => t.key !== 'account' || !!selfId);
  // MY ACCOUNT WINS ON THE SELF RECORD. /admin/settings/users/<self> is matched by the Users tab's
  // prefix too, so without this the manager who just clicked "My account" would see "Users"
  // highlighted and the roster's sub-tabs — told they are somewhere they are not.
  const accountActive = !!selfId && path === `/admin/settings/users/${selfId}`;
  const active = accountActive
    ? TABS.find((t) => t.key === 'account')
    : TABS.find((t) => t.match.some((m) => path === m || path.startsWith(m + '/')));
  // Both the top tab and its My Account sub-tab resolve to the caller's OWN record.
  const hrefFor = (t: TopTab | SubTab) =>
    ('key' in t ? t.key === 'account' : t.name === 'My Account') && selfId
      ? `/admin/settings/users/${selfId}`
      : t.href;
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
            // RESOLVED href, not the placeholder — My Account points at the caller's own record and
            // its active test has to compare against the same string it navigates to.
            const href = hrefFor(s);
            const on = path === href || path.startsWith(href + '/');
            return <Link key={s.name} href={href} className={subCls(on)}>{s.name}</Link>;
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
