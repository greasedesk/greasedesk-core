/**
 * File: components/rep-site/RepSiteChrome.tsx
 * Header + footer for the PUBLIC reseller site at reps.greasedesk.com.
 *
 * ── WHY NOT components/marketing/SiteChrome ─────────────────────────────────────────────────────
 * Because every link in it 404s here. SiteChrome's CTAs are /admin/login and /register, its footer
 * links /contact, and its nav falls back to /#features and /pricing — and the rep host's middleware
 * allow-list serves NONE of those. Reusing it would have produced a header of dead links on the one
 * page a reseller lands on from a phone. It also reads its nav from the Content system, which is the
 * GARAGE site's nav.
 *
 * So: the same design tokens, the same company-info facts, its own two links. Small on purpose —
 * this site is one page, its terms, and a form.
 *
 * ── THE WORD (owner, 2026-09-12) ────────────────────────────────────────────────────────────────
 * "RESELLER" in public copy; "rep" stays the internal word, in the schema, the host, the portal
 * routes and the gates. Two words for one person, chosen deliberately: the public one is what a
 * tool-van rep recognises, and renaming the internal one would touch the schema and every gate. Where
 * the two meet — the portal, after signup — the copy says reseller.
 *
 * ── MOBILE FIRST ────────────────────────────────────────────────────────────────────────────────
 * This is opened from a phone, from a link in a video description. Base styles are the phone; every
 * wider rule is an `sm:`/`md:` addition, never the other way round.
 */
import Link from 'next/link';
import { COMPANY } from '@/lib/company-info';

const YEAR = 2026; // © year — a deliberate constant, as on the marketing site (no Date.now in render)

export default function RepSiteChrome({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-surface text-ink flex flex-col">
      <header className="border-b border-line bg-surface">
        <div className="max-w-4xl mx-auto px-4 sm:px-6 py-3 flex items-center justify-between gap-4">
          <Link href="/" className="flex items-center gap-2.5" aria-label="GreaseDesk resellers — home">
            {/* The ONE asset outside /rep-site that this host serves: middleware's exact-match brand file. */}
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
            <Link href="/" className="hover:text-ink">Become a reseller</Link>
            {/*
              RESELLER TERMS: LINK DELIBERATELY ABSENT until the solicitor's text lands (owner,
              2026-09-12). The page and its route stay — /terms is live and returns 200 — but the
              prose is placeholder under a "not final" note, and this site is about to be promoted.
              A reseller who clicks through to unfinished terms learns something about how ready
              this is, on the page where we are asking them to trust us with their round.
              PUT IT BACK when the reviewed agreement is published, and delete rep-site-gate's
              "the footer does not link to terms" clause in the same commit.
            */}
            <Link href="/rep/login" className="hover:text-ink">Reseller sign in</Link>
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
