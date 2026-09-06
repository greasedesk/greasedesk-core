/**
 * File: components/layout/EngineRoomLayout.tsx
 * The Engine Room application shell (operator portal). Mirrors the tenant AdminLayout's STRUCTURE —
 * fixed left nav column with the wordmark at top, Settings + Sign out pinned at the bottom, main
 * content to the right.
 *
 * ── ONE PALETTE, TWO THEMES ─────────────────────────────────────────────────────────────────────
 * An operator with both portals open must never confuse them, and the distinction that carries that
 * is DARK THROUGHOUT against the tenant's light workspace — not a second set of colours. This shell
 * was built in raw slate, 320 hardcoded colours across the Engine Room against tailwind.config's
 * own instruction ("never raw slate/blue or hex"), and the result was a rail at slate-900 beside a
 * tenant rail at navy #0B1E3B: near enough to look like a mistake, far enough to be one.
 *
 * Everything here is now the SAME token the tenant app uses. The theme is stamped in _document for
 * /superadmin routes, so `--surface` resolves dark here and light there while the markup is
 * identical — and the rail and the accent are the brand's own values on both, unchanged by theme.
 *
 * The nav renders from the SESSION PRINCIPAL's role (erNavFor) — a link the role would 404 on is
 * never shown. That is a convenience, NOT the guard: every screen behind a nav item independently
 * enforces its own role in getServerSideProps (erMinRole), so a Support operator typing /operators
 * gets a real 404, not merely a missing link.
 */
import Link from 'next/link';
import { useRouter } from 'next/router';
import { signOut } from 'next-auth/react';
// FROM THE LEAF MODULE, NOT operator-auth. This is a client component: importing a value from
// operator-auth pulls prisma into the browser bundle and every Engine Room page throws.
import { erNavFor, type OperatorRoleName } from '@/lib/operator-roles';
import BrandLogo from '@/components/BrandLogo';

export default function EngineRoomLayout({ role, children }: { role: OperatorRoleName; children: React.ReactNode }) {
  const router = useRouter();
  const items = erNavFor(role);
  const isActive = (href: string) => router.pathname === href || router.pathname.startsWith(href + '/');
  // The SAME shape the tenant rail uses: accent for the active item, sidebar tokens for the rest.
  const link = (active: boolean) =>
    `block p-3 rounded-lg text-sm transition ${active ? 'bg-accent text-sidebar-active font-medium' : 'text-sidebar-fg hover:bg-sidebar-line hover:text-sidebar-active'}`;

  return (
    <div className="min-h-screen flex bg-content text-ink">
      <aside className="w-64 shrink-0 bg-sidebar border-r border-sidebar-line p-4 sticky top-0 h-screen flex flex-col">
        {/* THE PRODUCT'S OWN MARK, not a hand-rolled "ER" square — this is GreaseDesk, and the label
            below it says which part. `plate` stays on: the logo PNG has dark-navy parts that would
            vanish against the rail without it (see components/BrandLogo). */}
        <div className="px-1 mb-6">
          <BrandLogo href="/superadmin" width={132} />
          <div className="mt-2 text-sm font-semibold tracking-tight text-sidebar-active">Engine Room</div>
        </div>

        <nav className="space-y-1">
          {items.map((it) => (
            <Link key={it.href} href={it.href} className={link(isActive(it.href))}>{it.label}</Link>
          ))}
        </nav>

        {/* Settings (all roles) + Sign out, pinned at the bottom — mirrors the tenant shell. */}
        <div className="mt-auto pt-4 space-y-1 border-t border-sidebar-line">
          <Link href="/superadmin/settings" className={link(isActive('/superadmin/settings'))}>Settings</Link>
          <button
            onClick={() => signOut({ callbackUrl: '/superadmin/login' })}
            className="w-full text-left p-3 rounded-lg text-sm text-sidebar-muted hover:text-sidebar-active hover:bg-sidebar-line transition"
          >
            Sign out
          </button>
          {/* Disclosure only — the Engine Room runs strictly-necessary session cookies (no banner).
              Absolute apex URL: the policy page lives on greasedesk.com, not this (er.) origin. */}
          <a href="https://greasedesk.com/cookies" className="block px-3 pt-1 text-[11px] text-sidebar-muted hover:text-sidebar-fg">Cookies</a>
        </div>
      </aside>

      <main className="flex-1 min-w-0 overflow-x-auto">{children}</main>
    </div>
  );
}
