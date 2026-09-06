/**
 * File: components/layout/EngineRoomLayout.tsx
 * The Engine Room application shell (operator portal). Mirrors the tenant AdminLayout's STRUCTURE —
 * fixed left nav column with the wordmark at top, Settings + Sign out pinned at the bottom, main
 * content to the right.
 *
 * ── IT LOOKS LIKE THE PRODUCT, BECAUSE IT IS THE PRODUCT ────────────────────────────────────────
 * Dark navy rail, light workspace, the same semantic tokens as the tenant app — bg-surface,
 * text-ink, border-line, bg-accent. Nothing here is a second palette, and nothing here is a second
 * theme: this reads as GreaseDesk because it is GreaseDesk.
 *
 * WHAT TELLS AN OPERATOR WHICH PORTAL THEY ARE IN is the hostname — er.greasedesk.com serves the
 * Engine Room and 404s every tenant route — and the "Engine Room" label under the logo. Not the
 * colours. This shell argued for the opposite twice: first in raw slate, then in a dark theme, on
 * the grounds that an operator with both open could confuse them. A URL bar and a label do that job
 * without maintaining a separate look, and a portal that looks like a different product is a cost
 * paid on every screen to solve a problem that only exists for a moment.
 *
 * Colours come from the tokens (tailwind.config / styles/globals.css) — no raw slate, no hex, no
 * raw Tailwind colour scale. engine-room-palette-gate holds that, whichever theme is selected.
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
