/**
 * File: components/layout/AdminLayout.tsx
 * Persistent shell for authenticated /admin pages: dark navy rail + light workspace. Mounted ONCE
 * in _app for all /admin routes (except login), so it never remounts on navigation.
 *
 * Location switching is CONTEXTUAL, not a global bar: the location-scoped sections (Diary, Job
 * Cards) expand a sub-menu of the user's accessible locations when active. The sub-menu lists
 * exactly what getVisibility allows (admin → all sites, manager → assigned, mechanic → their one),
 * so the nav itself enforces the access model. Clicking a section lands on the user's PRIMARY
 * location; the sub-menu switches. Job Cards additionally offers "All locations" (multi-site only).
 * Colours come from semantic tokens (see styles/globals.css / tailwind.config.js) — no raw slate.
 */
import React, { useState, useEffect } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/router';
import { signOut, useSession } from 'next-auth/react';
import { useTranslation } from 'next-i18next';
import BrandLogo from '@/components/BrandLogo';
import BillingBanner from '@/components/layout/BillingBanner';
import DemoBanner from '@/components/layout/DemoBanner';

type Loc = { id: string; site_name: string };
type NavItemDef = { key: string; href: string; icon: string; ready: boolean; locScope?: 'diary' | 'jobcards'; needsInvoicePerm?: boolean; adminOnly?: boolean;
  /** Optional count rendered as a pill. `countKey` names which count this item reads — the value is
   *  passed in by the page, because only the page's server side knows it. Absent = no pill, and a
   *  ZERO renders NOTHING: a badge showing 0 is noise pretending to be information. */
  countKey?: 'messages' | 'marketing' };

// `key` is a stable i18n key (translated via t(`nav.${key}`)); display text lives in locale files.
// locScope marks sections that expand a per-location sub-menu.
const navItems: NavItemDef[] = [
  { key: 'dashboard', href: '/admin/dashboard', icon: '🏠', ready: true },
  { key: 'diary', href: '/admin/diary', icon: '🗓️', ready: true, locScope: 'diary' },
  { key: 'jobCards', href: '/admin/jobcards', icon: '🛠️', ready: true, locScope: 'jobcards' },
  { key: 'quotes', href: '/admin/quotes', icon: '📝', ready: true },
  // The count is UNREAD inbound messages — as a badge on Messages is supposed to mean. It counted
  // open conversations while nothing could arrive, because a badge that could only ever read zero
  // is decoration; inbound made unread a real number. See lib/message-threads::unreadThreadCount.
  { key: 'messages', href: '/admin/messages', icon: '💬', ready: true, countKey: 'messages' },
  // The count is UNACTIONED cars, not the size of the lists — same lesson as Messages above, from
  // the other side: a badge that only ever grows is one a garage stops seeing. It falls as the list
  // is worked. See lib/marketing-lists::isUnactioned.
  { key: 'marketing', href: '/admin/marketing', icon: '📣', ready: true, countKey: 'marketing' },
  { key: 'invoices', href: '/admin/invoices', icon: '🧾', ready: true, needsInvoicePerm: true },
  // After the money that's owed, before the things that cost money. adminOnly for the same reason
  // as HR: payout history and bank details are owner-grade, and a can_invoice mechanic may RAISE an
  // invoice without having any business seeing what landed in the bank. The page re-checks
  // server-side, and so does the Stripe account session it mints.
  { key: 'payments', href: '/admin/payments', icon: '💳', ready: true, adminOnly: true },
  { key: 'products', href: '/admin/products', icon: '📦', ready: true },
  { key: 'roster', href: '/admin/roster', icon: '📅', ready: true },
  { key: 'hr', href: '/admin/hr', icon: '🗂️', ready: true, adminOnly: true }, // wages live here — page + APIs re-check server-side
  { key: 'customers', href: '/admin/customers', icon: '👤', ready: false },
  { key: 'reports', href: '/admin/reports', icon: '📊', ready: false },
];
const visibleNavItems = navItems.filter((item) => item.ready);

interface AdminLayoutProps {
  children: React.ReactNode;
  /**
   * ── A BOUNDED BOX, FOR PAGES WHOSE PANES SCROLL THEMSELVES ────────────────────────────────────
   * Off by default: the shell is `min-h-screen` and the whole document scrolls, which is right for
   * every page that is a column of content.
   *
   * A page with independently-scrolling panes needs the opposite — a box of known height to fill.
   * It cannot compute that height itself: a `calc(100vh - …)` would have to know whether this
   * tenant is showing DemoBanner, BillingBanner or the WorkshopNudge, all of which sit inside
   * <main> above the content and vary in height. So the browser computes it — the banners take
   * their natural size and the content div takes `flex-1 min-h-0`, which is the remainder.
   *
   * `min-h-0` is the load-bearing part. Without it a flex child refuses to shrink below its own
   * content, and the panes push past the viewport instead of scrolling inside it.
   */
  fullHeight?: boolean;
}

const navLink = (active: boolean) =>
  `flex items-center p-3 rounded-lg transition-colors duration-200 ${
    active ? 'bg-accent text-sidebar-active font-semibold' : 'text-sidebar-fg hover:bg-sidebar-line'
  }`;

const subLink = (active: boolean) =>
  `block px-3 py-1.5 rounded-md text-sm transition-colors ${
    active ? 'bg-accent text-white font-medium' : 'text-sidebar-muted hover:text-sidebar-active hover:bg-sidebar-line'
  }`;

// Shared nav renderer (desktop sidebar + mobile overlay). onNavigate closes the mobile menu.
function NavList({
  pathname, siteQuery, locations, primarySiteId, t, onNavigate, canViewInvoices, isAdmin, messagesCount, marketingCount,
}: {
  pathname: string; siteQuery: string; locations: Loc[]; primarySiteId: string | null;
  t: (k: string) => string; onNavigate?: () => void; canViewInvoices?: boolean; isAdmin?: boolean;
  messagesCount?: number | null; marketingCount?: number | null;
}) {
  return (
    <>
      {visibleNavItems.filter((item) => (!item.needsInvoicePerm || canViewInvoices) && (!item.adminOnly || isAdmin)).map((item) => {
        const active = pathname === item.href || pathname.startsWith(item.href + '/');
        const showSub = !!item.locScope && active && locations.length > 0;
        // Which location the current view is showing (for highlight). "All" only applies to Job Cards.
        const isAll = item.locScope === 'jobcards' && siteQuery === 'all';
        const selected = isAll ? '' : (siteQuery && siteQuery !== 'all' ? siteQuery : (primarySiteId ?? ''));
        return (
          <div key={item.key}>
            <Link href={item.href} onClick={onNavigate} className={navLink(active)}>
              <span className="mr-3 text-lg">{item.icon}</span>
              {t(`nav.${item.key}`)}
              {item.countKey === 'messages' && typeof messagesCount === 'number' && messagesCount > 0 && (
                <span data-testid="nav-count-messages"
                  className="ml-auto text-xs font-semibold rounded-full px-2 py-0.5 bg-accent text-white">
                  {messagesCount}
                </span>
              )}
              {/* ZERO RENDERS NOTHING, like Messages: an empty list is a finished list, and a pill
                  saying 0 is decoration. Null (not yet known) renders nothing either. */}
              {item.countKey === 'marketing' && typeof marketingCount === 'number' && marketingCount > 0 && (
                <span data-testid="nav-count-marketing"
                  className="ml-auto text-xs font-semibold rounded-full px-2 py-0.5 bg-accent text-white">
                  {marketingCount}
                </span>
              )}
            </Link>
            {showSub && (
              <div className="mt-1 mb-1 ml-4 pl-3 border-l border-sidebar-line space-y-0.5">
                {item.locScope === 'jobcards' && locations.length > 1 && (
                  <Link href={`${item.href}?site=all`} onClick={onNavigate} className={subLink(isAll)}>
                    {t('nav.allLocations')}
                  </Link>
                )}
                {locations.map((loc) => (
                  <Link key={loc.id} href={`${item.href}?site=${loc.id}`} onClick={onNavigate} className={subLink(loc.id === selected)}>
                    {loc.site_name}
                  </Link>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </>
  );
}

export default function AdminLayout({ children, fullHeight = false }: AdminLayoutProps) {
  // THE SHELL OWNS THE PILL COUNT. It used to arrive as a prop from /admin/messages, which forced
  // that page to mount its own AdminLayout inside this persistent one — two shells, two nav
  // columns. It also meant the pill appeared ONLY on the Messages page, the one place you don't
  // need telling. Null until known: absent renders no pill, and unknown is not zero.
  const [messagesCount, setMessagesCount] = useState<number | null>(null);
  const [marketingCount, setMarketingCount] = useState<number | null>(null);
  const router = useRouter();
  const { t } = useTranslation('common');
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);
  const [locations, setLocations] = useState<Loc[]>([]);
  const [primarySiteId, setPrimarySiteId] = useState<string | null>(null);
  const [canViewInvoices, setCanViewInvoices] = useState(false);
  const [isAdmin, setIsAdmin] = useState(false);

  // Unlike the locations fetch below, this one repeats on navigation: unread changes as you read.
  useEffect(() => {
    let live = true;
    fetch('/api/messages/unread')
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (live && d) setMessagesCount(typeof d.unread === 'number' ? d.unread : null); })
      .catch(() => {});
    return () => { live = false; };
  }, [router.pathname, router.asPath]);

  // Repeats on navigation for the same reason: the number falls as somebody works the list, and a
  // badge that only refreshed on a hard reload would look stuck.
  useEffect(() => {
    let live = true;
    fetch('/api/marketing/unactioned')
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (live && d) setMarketingCount(typeof d.unactioned === 'number' ? d.unactioned : null); })
      .catch(() => {});
    return () => { live = false; };
  }, [router.pathname, router.asPath]);

  // Fetches ONCE for the whole admin session (this shell is persistent — never remounts on nav).
  useEffect(() => {
    let active = true;
    fetch('/api/locations')
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (active && d) {
          setLocations(d.locations || []);
          setPrimarySiteId(d.primarySiteId ?? null);
          setCanViewInvoices(!!d.canViewInvoices);
          setIsAdmin(!!d.isAdmin);
        }
      })
      .catch(() => {});
    return () => { active = false; };
  }, []);

  const siteQuery = typeof router.query.site === 'string' ? router.query.site : '';

  return (
    <div className={`${fullHeight ? 'h-screen overflow-hidden' : 'min-h-screen'} bg-content text-ink flex`}>
      {/* --- Desktop sidebar (dark rail) --- */}
      {/* ── A FLEX COLUMN, NOT AN ABSOLUTE FOOTER ────────────────────────────────────────────
          The bottom block used to be `absolute bottom-4` inside this `overflow-y-auto` box. An
          absolutely-positioned child is placed against the SCROLLABLE content, so the moment the
          nav grew taller than the rail it stopped sitting below the links and started sitting ON
          them: Payments over Products, Settings over Products, Sign Out over Roster. It looked
          fine on a tall desktop window and broke on an iPad, which is why nobody caught it.
          Now: the nav is the only thing that scrolls (flex-1 + min-h-0 — without min-h-0 a flex
          child refuses to shrink below its content and the whole rail scrolls instead), and the
          footer is in normal flow, so it cannot overlap anything by construction. */}
      <aside className="hidden md:flex w-64 bg-sidebar border-r border-sidebar-line p-4 sticky top-0 h-screen flex-col">
        <div className="mb-8 shrink-0"><BrandLogo /></div>

        <nav className="space-y-2 flex-1 min-h-0 overflow-y-auto">
          <NavList pathname={router.pathname} siteQuery={siteQuery} locations={locations} primarySiteId={primarySiteId} t={t} canViewInvoices={canViewInvoices} isAdmin={isAdmin} messagesCount={messagesCount} />
        </nav>

        {/* Settings (cog) sits at the bottom, directly above Sign Out. */}
        <div className="shrink-0 pt-3 mt-2 border-t border-sidebar-line space-y-1">
          <Link href="/admin/settings" className={navLink(router.pathname.startsWith('/admin/settings'))}>
            <span className="mr-3 text-lg">⚙️</span>
            {t('nav.settings')}
          </Link>
          <button
            onClick={() => signOut({ callbackUrl: '/admin/login' })}
            className="w-full text-left p-3 rounded-lg text-sm text-sidebar-muted hover:text-sidebar-active transition"
          >
            {t('nav.signOut')}
          </button>
          {/* Disclosure only — the app runs strictly-necessary session cookies (no banner here). */}
          <Link href="/cookies" className="block px-3 text-[11px] text-sidebar-muted/70 hover:text-sidebar-active">Cookies</Link>
        </div>
      </aside>

      {/* --- Main content area (light workspace) --- */}
      <main className="flex-1 flex flex-col min-w-0 min-h-0 bg-content">
        {/* Mobile header */}
        {/* Exact h-14 (56px): the job-card tab strip sticks at top-14 directly beneath it. */}
        <header className="bg-sidebar border-b border-sidebar-line h-14 px-3 md:hidden flex justify-between items-center sticky top-0 z-30">
          <button
            onClick={() => setIsSidebarOpen(!isSidebarOpen)}
            className="text-sidebar-active w-11 h-11 flex items-center justify-center text-2xl rounded-md hover:bg-sidebar-line transition"
            aria-label={t('nav.toggleMenu')}
          >
            ☰
          </button>
          <BrandLogo width={72} slim />
        </header>

        {/* Page content */}
        <WorkshopNudge t={t} />
        {/* THE CONTENT CONTAINER, and the one place that decides how a page sits in it: full
            width, LEFT-ALIGNED. This layout previously expressed no opinion, so pages invented
            their own — Invoices, Roster and HR each added `max-w-* mx-auto` independently, with
            three different widths, and centred themselves while the rest of the app did not.
            A page may cap its own READING WIDTH (a form is not a table); it must not centre
            itself. `mx-auto` does not belong in a page under /admin. */}
        {/* ABOVE the content and inside the scroll region, so it is the first thing on every admin
            page rather than something only Settings → Licence ever showed. */}
        <DemoBanner />
        <BillingBanner />
        <div className={`flex-1 p-4 sm:p-6 lg:p-8 ${fullHeight ? 'min-h-0 overflow-hidden' : ''}`}>{children}</div>
      </main>

      {/* --- Mobile menu overlay --- */}
      {isSidebarOpen && (
        <div className="fixed inset-0 bg-black/50 z-20 md:hidden" onClick={() => setIsSidebarOpen(false)}>
          <div className="w-64 bg-sidebar h-full p-4 overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            <div className="mb-8"><BrandLogo /></div>
            <nav className="space-y-2">
              <NavList
                pathname={router.pathname} siteQuery={siteQuery} locations={locations} primarySiteId={primarySiteId}
                t={t} onNavigate={() => setIsSidebarOpen(false)} canViewInvoices={canViewInvoices} isAdmin={isAdmin}
                messagesCount={messagesCount}
                marketingCount={marketingCount}
              />
            </nav>
            <Link href="/admin/settings" onClick={() => setIsSidebarOpen(false)} className={`mt-4 ${navLink(router.pathname.startsWith('/admin/settings'))}`}>
              <span className="mr-3 text-lg">⚙️</span>
              {t('nav.settings')}
            </Link>
            <button
              onClick={() => { setIsSidebarOpen(false); signOut({ callbackUrl: '/admin/login' }); }}
              className="w-full p-3 text-left text-sm text-sidebar-muted hover:text-sidebar-active transition"
            >
              {t('nav.signOut')}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// A NUDGE, never a redirect: a dismissible pointer to the workshop view on a narrow viewport.
// md:hidden = CSS-narrow, not UA-sniffed; dismissal remembered FOREVER per browser.
// SUPPRESSED (ruling 2026-07-14, demo hardening) for ADMIN and SITE_MANAGER — they OPENED the
// admin app deliberately (STANDARD mechanics land on /m and never see this), and NEVER on the
// diary — an admin on a phone looking at the diary knows exactly where they are. With the current
// role model those two gates mean it doesn't nag anyone during a demo; the component + its
// dismissible-forever memory stay for any future non-admin role that reaches the admin app.
function WorkshopNudge({ t }: { t: (k: string) => string }) {
  const router = useRouter();
  const { data: session } = useSession();
  const role = (session?.user as any)?.role;
  const [show, setShow] = React.useState(false);
  React.useEffect(() => {
    try { setShow(localStorage.getItem('gd-m-nudge') !== 'dismissed'); } catch { setShow(true); }
  }, []);
  if (!show) return null;
  if (role === 'ADMIN' || role === 'SITE_MANAGER') return null; // they chose the admin app — no nag
  if (router.pathname.startsWith('/admin/diary')) return null;   // never on the diary
  return (
    <div className="md:hidden flex items-center gap-2 px-4 py-2 text-sm bg-accent-soft text-accent border-b border-line">
      <a href="/m" className="flex-1 font-medium underline min-h-[44px] flex items-center">{t('workshopNudge')}</a>
      <button
        onClick={() => { setShow(false); try { localStorage.setItem('gd-m-nudge', 'dismissed'); } catch { /* pref only */ } }}
        aria-label={t('dismiss')}
        className="min-h-[44px] min-w-[44px] text-accent"
      >✕</button>
    </div>
  );
}
