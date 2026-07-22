/**
 * File: components/marketing/SiteChrome.tsx
 * Shared header + footer for the public marketing site, on the APP's semantic design tokens
 * (surface/ink/line/accent) — so the site and the product read as one thing (the gd* palette is
 * retired here). Legal facts come from lib/company-info; wrap any public page in <SiteChrome>.
 */
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { COMPANY, officeOneLine } from '@/lib/company-info';
import { useConsent } from '@/components/consent/ConsentProvider';
import { useNav } from '@/components/marketing/NavProvider';
import type { PublicNavLink } from '@/lib/nav';

const YEAR = 2026; // © year — bump per release (Date.now is avoided; this is a deliberate constant)

/** Footer "Cookie settings" — re-opens the consent banner in Manage mode so a choice is changeable. */
function CookieSettingsLink() {
  const { openManage } = useConsent();
  return <button type="button" onClick={openManage} className="text-left text-muted hover:text-ink">Cookie settings</button>;
}

/** Footer link column — rendered from the Content-system nav config, plus the Cookie-settings action. */
function FooterNav() {
  const { footer } = useNav();
  return (
    <nav className="flex flex-col gap-2 text-sm" aria-label="Footer">
      <span className="text-xs uppercase tracking-wide text-muted mb-1">GreaseDesk</span>
      {footer.map((l) => navLink(l, 'text-muted hover:text-ink'))}
      <CookieSettingsLink />
    </nav>
  );
}

// Render a config nav link — internal (next/link) or external (plain <a>, safe rel). Nav content comes
// from the Content system (NavProvider); the auth CTAs (Sign in / Start free trial) stay structural.
function navLink(l: PublicNavLink, className: string, onClick?: () => void) {
  return l.external
    ? <a key={l.label + l.href} href={l.href} target="_blank" rel="noopener noreferrer" onClick={onClick} className={className}>{l.label}</a>
    : <Link key={l.label + l.href} href={l.href} onClick={onClick} className={className}>{l.label}</Link>;
}

function Header() {
  const { main } = useNav();
  const [open, setOpen] = useState(false);
  const [scrolled, setScrolled] = useState(false);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    const onScroll = () => setScrolled(window.scrollY > 4);
    onScroll();
    window.addEventListener('keydown', onKey);
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => { window.removeEventListener('keydown', onKey); window.removeEventListener('scroll', onScroll); };
  }, []);

  return (
    // STICKY: the primary action (trial CTA) and the burger stay reachable through a long page.
    // Safe-area aware so it clears the notch; the shadow only appears once scrolled, so it reads flat at rest.
    <header
      className={`sticky top-0 z-50 bg-surface border-b transition-shadow ${scrolled ? 'border-line shadow-card' : 'border-transparent'}`}
      style={{ paddingTop: 'env(safe-area-inset-top)' }}>
      <nav className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 flex justify-between items-center h-16">
        {/* Mark + wordmark — the SAME gear-and-spanner mark the product uses, so site and app match. */}
        <Link href="/" className="flex items-center gap-2.5" aria-label="GreaseDesk — home">
          <img src={COMPANY.markPath} alt="" width={32} height={32} className="w-8 h-8" />
          <span className="text-xl font-extrabold text-ink tracking-tight">GreaseDesk</span>
        </Link>

        {/* Desktop nav (sm+) — content links from the Content-system nav config; auth CTAs structural. */}
        <div className="hidden sm:flex items-center gap-5 text-sm">
          {main.map((l) => navLink(l, 'text-muted hover:text-ink transition-colors'))}
          <span className="w-px h-5 bg-line" aria-hidden="true" />
          <Link href="/admin/login" className="text-muted hover:text-ink transition-colors">Sign in</Link>
          <Link href="/register" className="inline-block bg-accent hover:bg-accent-hover text-white font-medium rounded-lg px-4 py-2 transition-colors">Start free trial</Link>
        </div>

        {/* Mobile: one 44px hamburger — nothing crushed, and it still works as the nav grows. */}
        <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} aria-controls="site-menu"
          aria-label={open ? 'Close menu' : 'Open menu'}
          className="sm:hidden -mr-2 w-11 h-11 flex items-center justify-center rounded-lg text-ink hover:bg-surface-muted">
          <svg viewBox="0 0 24 24" className="w-6 h-6" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round">
            {open ? <path d="M6 6l12 12M18 6L6 18" /> : <><path d="M4 7h16" /><path d="M4 12h16" /><path d="M4 17h16" /></>}
          </svg>
        </button>
      </nav>

      {open && (
        <div id="site-menu" className="sm:hidden border-t border-line bg-surface max-h-[calc(100vh-4rem)] overflow-y-auto">
          <div className="max-w-6xl mx-auto px-4 py-2 flex flex-col">
            {main.map((l) => navLink(l, 'py-3.5 text-base text-ink border-b border-line', () => setOpen(false)))}
            <Link href="/admin/login" onClick={() => setOpen(false)} className="py-3.5 text-base text-ink border-b border-line">Sign in</Link>
            <Link href="/register" onClick={() => setOpen(false)}
              className="my-3 bg-accent hover:bg-accent-hover text-white font-semibold rounded-lg px-4 py-3 text-center transition-colors">
              Start free trial
            </Link>
          </div>
        </div>
      )}
    </header>
  );
}

function Footer() {
  return (
    <footer className="border-t border-line bg-surface-muted mt-24">
      <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-12">
        <div className="flex flex-col sm:flex-row sm:justify-between gap-8">
          <div className="max-w-sm">
            <div className="text-lg font-extrabold text-ink">{COMPANY.trademark}</div>
            <p className="mt-2 text-sm text-muted">Garage management software — job cards, bookings, invoicing and a live view of your real profit.</p>
          </div>
          <FooterNav />
          <div className="flex flex-col gap-2 text-sm">
            <span className="text-xs uppercase tracking-wide text-muted mb-1">Contact</span>
            <a href={`tel:${COMPANY.phoneE164}`} className="text-muted hover:text-ink">{COMPANY.phone}</a>
            <Link href="/contact" className="text-muted hover:text-ink">Send us a message</Link>
          </div>
        </div>
        {/* Legal identity — read from company-info, never hardcoded. */}
        <div className="mt-10 pt-6 border-t border-line text-xs text-muted flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
          <p>
            {COMPANY.legalName} · Company No. {COMPANY.companyNumber} · Registered office: {officeOneLine()}
          </p>
          <p>© {YEAR} {COMPANY.legalName}. {COMPANY.trademark} is a trademark of {COMPANY.legalName}.</p>
        </div>
      </div>
    </footer>
  );
}

export default function SiteChrome({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-surface text-ink flex flex-col">
      <Header />
      <main className="flex-1">{children}</main>
      <Footer />
    </div>
  );
}
