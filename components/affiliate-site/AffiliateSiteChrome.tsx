/**
 * File: components/affiliate-site/AffiliateSiteChrome.tsx
 * Header + footer for the PUBLIC affiliate site at affiliates.greasedesk.com.
 *
 * ── WHY NOT RepSiteChrome, AND WHY NOT SiteChrome ───────────────────────────────────────────────
 * SiteChrome is the garage site's: every link in it (/admin/login, /register, /contact, /pricing)
 * 404s on this host, and its nav comes from the Content system, which is the GARAGE nav.
 * RepSiteChrome is the reseller's: its links say "Become a reseller" and point at /rep-site, which
 * also 404s here — and a reseller and an affiliate are not the same person doing the same thing.
 *
 * So: the same design tokens, the same company-info facts, its own two links. Small on purpose —
 * this site is one page, its terms and a form.
 *
 * ── THE WORD ────────────────────────────────────────────────────────────────────────────────────
 * "Affiliate" in public copy and in the schema both, unlike the reseller programme's two words.
 * Nothing to reconcile: the people this is for — a motor factor rep, a diagnostics YouTuber —
 * recognise the word, and PartyType.affiliate already uses it internally.
 *
 * ── MOBILE FIRST ────────────────────────────────────────────────────────────────────────────────
 * Opened from a phone, from a link in a video description. Base classes are the phone; `sm:` and up
 * only ever add.
 */
import Link from 'next/link';
import { COMPANY } from '@/lib/company-info';

const YEAR = 2026; // © year — a deliberate constant, as on the marketing and reseller sites.

export default function AffiliateSiteChrome({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-surface text-ink flex flex-col">
      <header className="border-b border-line bg-surface">
        <div className="max-w-4xl mx-auto px-4 sm:px-6 py-3 flex items-center justify-between gap-4">
          <Link href="/" className="flex items-center gap-2.5" aria-label="GreaseDesk affiliates — home">
            {/* The ONE asset outside /affiliate-site this host serves: middleware's exact-match brand file. */}
            <img src="/greasedesk-Logo.png" alt="GreaseDesk" className="h-7 w-auto" />
          </Link>
          {/* 44px minimum: a phone number on a phone is the one control that must never be fiddly. */}
          <a href={`tel:${COMPANY.phoneE164}`} className="text-sm font-medium text-accent hover:underline whitespace-nowrap inline-flex items-center min-h-[44px] px-1">
            {COMPANY.phone}
          </a>
        </div>
      </header>

      <main className="flex-1">{children}</main>

      <footer className="border-t border-line bg-surface-muted mt-12">
        <div className="max-w-4xl mx-auto px-4 sm:px-6 py-8 text-sm text-muted space-y-3">
          <nav className="flex flex-wrap gap-x-6 gap-y-2" aria-label="Footer">
            <Link href="/" className="hover:text-ink">Become an affiliate</Link>
            {/*
              THE TERMS LINK IS HERE, unlike the reseller site's — which deliberately has none until
              its solicitor-reviewed agreement lands. The difference is the owner's instruction for
              this slice (a placeholder link is acceptable for now) and the page it points at says
              plainly that the full terms are not final yet. The MONEY terms are not placeholder:
              they are stated in full on the home page, from the settings.
              When the reviewed document lands (slice H) this link does not move; the page's body
              is replaced by the Content system's version.
            */}
            <Link href="/terms" className="hover:text-ink">Affiliate terms</Link>
            <a href="https://greasedesk.com/privacy" className="hover:text-ink">Privacy</a>
          </nav>
          <p>
            {COMPANY.legalName} · Company number {COMPANY.companyNumber} · {COMPANY.office.line1}, {COMPANY.office.locality}, {COMPANY.office.postcode}
          </p>
          <p>© {YEAR} {COMPANY.legalName}. All rights reserved.</p>
        </div>
      </footer>
    </div>
  );
}
