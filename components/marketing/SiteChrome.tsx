/**
 * File: components/marketing/SiteChrome.tsx
 * Shared header + footer for the public marketing site, on the APP's semantic design tokens
 * (surface/ink/line/accent) — so the site and the product read as one thing (the gd* palette is
 * retired here). Legal facts come from lib/company-info; wrap any public page in <SiteChrome>.
 */
import Link from 'next/link';
import { COMPANY, officeOneLine } from '@/lib/company-info';

const YEAR = 2026; // © year — bump per release (Date.now is avoided; this is a deliberate constant)

function Header() {
  return (
    <header className="border-b border-line bg-surface">
      <nav className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 flex justify-between items-center h-16">
        <Link href="/" className="text-xl font-extrabold text-ink tracking-tight">GreaseDesk</Link>
        <div className="flex items-center gap-4 sm:gap-6 text-sm">
          <Link href="/#features" className="hidden sm:inline text-muted hover:text-ink transition-colors">Features</Link>
          <Link href="/pricing" className="text-muted hover:text-ink transition-colors">Pricing</Link>
          <Link href="/contact" className="hidden sm:inline text-muted hover:text-ink transition-colors">Contact</Link>
          <span className="hidden sm:inline w-px h-5 bg-line" aria-hidden="true" />
          <Link href="/admin/login" className="text-muted hover:text-ink transition-colors">Sign in</Link>
          <Link href="/register" className="inline-block bg-accent hover:bg-accent-hover text-white font-medium rounded-lg px-4 py-2 transition-colors">Start free trial</Link>
        </div>
      </nav>
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
