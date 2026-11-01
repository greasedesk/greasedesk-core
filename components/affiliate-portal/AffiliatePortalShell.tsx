/**
 * File: components/affiliate-portal/AffiliatePortalShell.tsx
 * THE AFFILIATE PORTAL'S CHROME: the dark rail, the mobile menu, and the one way out.
 *
 * Deliberately the same shape as components/layout/AdminLayout — a 64-wide dark rail with the logo
 * at the top, a light workspace beside it, and a ☰ header below md. An affiliate who is also a
 * garage owner should not have to learn a second set of furniture.
 *
 * ── WHAT IS COPIED AND WHAT IS NOT ──────────────────────────────────────────────────────────────
 * The colours are the same semantic tokens (bg-sidebar, text-sidebar-fg…) so a theme change reaches
 * both. The STRUCTURE is not shared, and should not be: AdminLayout fetches locations, counts
 * unread messages, mounts the billing and demo banners and is mounted once in _app for every
 * /admin route. None of that exists here. A shared component would carry all of it for one tenant
 * of it, which is the shape that makes a layout untouchable later.
 *
 * ── THE FOOTER IS IN NORMAL FLOW ────────────────────────────────────────────────────────────────
 * Copied deliberately from AdminLayout's own note: its bottom block was once `absolute bottom-4`
 * inside a scrolling rail, so the moment the nav grew taller than the window Sign Out sat ON the
 * links. Here the nav is the only thing that scrolls (flex-1 + min-h-0) and the footer follows it.
 */
import React, { useState } from 'react';
import { signOut } from 'next-auth/react';
import BrandLogo from '@/components/BrandLogo';
import { portalHomePath, portalSignInPath } from '@/lib/party-portal';
import { PORTAL_SECTIONS, PORTAL_LINKS, type PortalNavKey } from '@/lib/affiliate-portal-nav';

const HOME = portalHomePath('affiliate');
const SIGN_IN = portalSignInPath('affiliate');

const navLink = (active: boolean) =>
  `flex items-center p-3 rounded-lg transition-colors duration-200 ${
    active ? 'bg-accent text-sidebar-active font-semibold' : 'text-sidebar-fg hover:bg-sidebar-line'
  }`;

/**
 * THE ITEMS ARE REAL LINKS to `#key`, not buttons calling a handler.
 *
 * So the address bar carries the section, a menu item can be opened in a new tab or sent to
 * somebody, and the page has one source of truth to read instead of state to keep in step with a
 * URL. The page listens for the hash; this component only has to say where each item points.
 */
function NavList({ active, onNavigate }: { active: PortalNavKey; onNavigate?: () => void }) {
  return (
    <>
      {PORTAL_SECTIONS.map((s) => (
        <a key={s.key} href={`#${s.key}`} onClick={onNavigate} data-testid={`portal-nav-${s.key}`}
          aria-current={active === s.key ? 'page' : undefined} className={navLink(active === s.key)}>
          <span className="mr-3 text-lg" aria-hidden="true">{s.icon}</span>
          {s.label}
        </a>
      ))}
    </>
  );
}

/**
 * The links that LEAVE the page, kept visibly apart from the sections — see the nav table's header.
 *
 * THEY HIGHLIGHT WHEN YOU ARE ON THEM, exactly as a section does. Terms is a page inside this same
 * shell, so an item that never marked itself current would leave the menu claiming you are still on
 * Overview while you are reading the agreement.
 */
function LinkList({ active, onNavigate }: { active: PortalNavKey; onNavigate?: () => void }) {
  return (
    <>
      {PORTAL_LINKS.map((l) => (
        <a key={l.key} href={l.href} onClick={onNavigate} data-testid={`portal-link-${l.key}`}
          aria-current={active === l.key ? 'page' : undefined} className={navLink(active === l.key)}>
          <span className="mr-3 text-lg" aria-hidden="true">📄</span>
          {l.label}
        </a>
      ))}
      <button type="button" onClick={() => { onNavigate?.(); signOut({ callbackUrl: SIGN_IN }); }}
        data-testid="portal-signout"
        className="w-full text-left p-3 rounded-lg text-sm text-sidebar-muted hover:text-sidebar-active transition">
        Sign out
      </button>
    </>
  );
}

export default function AffiliatePortalShell(
  { active, children }: { active: PortalNavKey; children: React.ReactNode },
) {
  const [open, setOpen] = useState(false);
  return (
    <div className="min-h-screen bg-content text-ink flex">
      <aside data-testid="portal-rail"
        className="hidden md:flex w-64 bg-sidebar border-r border-sidebar-line p-4 sticky top-0 h-screen flex-col">
        {/* href is PASSED, and that is the whole point: BrandLogo defaults to /admin/dashboard, which
            does not exist on this host. The default would have been a logo that 404s. */}
        <div className="mb-8 shrink-0" data-testid="portal-logo"><BrandLogo href={HOME} /></div>
        <nav className="space-y-2 flex-1 min-h-0 overflow-y-auto" aria-label="Affiliate menu">
          <NavList active={active} />
        </nav>
        <div className="shrink-0 pt-3 mt-2 border-t border-sidebar-line space-y-1">
          <LinkList active={active} />
        </div>
      </aside>

      <main className="flex-1 flex flex-col min-w-0 min-h-0 bg-content">
        {/* h-14 matches AdminLayout's mobile header exactly, for the same reason it is exact there. */}
        <header className="bg-sidebar border-b border-sidebar-line h-14 px-3 md:hidden flex justify-between items-center sticky top-0 z-30">
          <button type="button" onClick={() => setOpen(!open)} data-testid="portal-menu-button"
            aria-label={open ? 'Close the menu' : 'Open the menu'} aria-expanded={open}
            className="text-sidebar-active w-11 h-11 flex items-center justify-center text-2xl rounded-md hover:bg-sidebar-line transition">
            ☰
          </button>
          <BrandLogo width={72} slim href={HOME} />
        </header>
        {/* A CAPPED READING WIDTH, LEFT-ALIGNED — AdminLayout's own rule, and for its reason: a page
            may bound how wide its text runs; it may not centre itself and leave the rest of the app
            looking different. Nothing in this portal is a wide table. */}
        <div className="flex-1 p-4 sm:p-6 lg:p-8"><div className="max-w-3xl">{children}</div></div>
      </main>

      {open && (
        <div className="fixed inset-0 bg-black/50 z-20 md:hidden" onClick={() => setOpen(false)}>
          <div className="w-64 bg-sidebar h-full p-4 overflow-y-auto" data-testid="portal-mobile-nav"
            onClick={(e) => e.stopPropagation()}>
            <div className="mb-8"><BrandLogo href={HOME} /></div>
            {/* CLOSES ON NAVIGATE. The section changes underneath the overlay, so leaving it open
                would hide the thing the person just asked to see. */}
            <nav className="space-y-2" aria-label="Affiliate menu"><NavList active={active} onNavigate={() => setOpen(false)} /></nav>
            <div className="pt-3 mt-2 border-t border-sidebar-line space-y-1"><LinkList active={active} onNavigate={() => setOpen(false)} /></div>
          </div>
        </div>
      )}
    </div>
  );
}
