/**
 * File: components/marketing/SiteChrome.tsx
 * Shared header + footer for the public marketing site, on the APP's semantic design tokens
 * (surface/ink/line/accent) — so the site and the product read as one thing (the gd* palette is
 * retired here). Legal facts come from lib/company-info; wrap any public page in <SiteChrome>.
 */
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { COMPANY, officeOneLine } from '@/lib/company-info';

const YEAR = 2026; // © year — bump per release (Date.now is avoided; this is a deliberate constant)

// The mobile panel carries the FULL nav — nothing is dropped on a phone (the old header silently
// lost Features + Contact). Reseller lives here and in the footer, but deliberately NOT in the
// desktop nav bar: it's a secondary audience, and the bar stays for garages.
const MOBILE_LINKS = [
  { href: '/#features', label: 'Features' },
  { href: '/pricing', label: 'Pricing' },
  { href: '/contact', label: 'Contact' },
  { href: '/reseller', label: 'Become a reseller' },
  { href: '/admin/login', label: 'Sign in' },
];

function Header() {
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

        {/* Desktop nav (sm+) — Reseller intentionally absent (footer + mobile panel only). */}
        <div className="hidden sm:flex items-center gap-5 text-sm">
          <Link href="/#features" className="text-muted hover:text-ink transition-colors">Features</Link>
          <Link href="/pricing" className="text-muted hover:text-ink transition-colors">Pricing</Link>
          <Link href="/contact" className="text-muted hover:text-ink transition-colors">Contact</Link>
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
            {MOBILE_LINKS.map((l) => (
              <Link key={l.href} href={l.href} onClick={() => setOpen(false)}
                className="py-3.5 text-base text-ink border-b border-line last:border-b-0">{l.label}</Link>
            ))}
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
          <nav className="flex flex-col gap-2 text-sm" aria-label="Footer">
            <span className="text-xs uppercase tracking-wide text-muted mb-1">GreaseDesk</span>
            <Link href="/pricing" className="text-muted hover:text-ink">Pricing</Link>
            <Link href="/contact" className="text-muted hover:text-ink">Contact</Link>
            <Link href="/register" className="text-muted hover:text-ink">Start free trial</Link>
            <Link href="/admin/login" className="text-muted hover:text-ink">Sign in</Link>
            <Link href="/reseller" className="text-muted hover:text-ink">Become a reseller</Link>
          </nav>
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
