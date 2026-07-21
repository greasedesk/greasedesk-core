/**
 * File: components/layout/EngineRoomLayout.tsx
 * The Engine Room application shell (operator portal). Mirrors the tenant AdminLayout's STRUCTURE —
 * fixed left nav column with the wordmark at top, Settings + Sign out pinned at the bottom, main
 * content to the right — but is deliberately DARK throughout (slate), where the tenant app is light,
 * so an operator with both open can never confuse them.
 *
 * The nav renders from the SESSION PRINCIPAL's role (erNavFor) — a link the role would 404 on is
 * never shown. That is a convenience, NOT the guard: every screen behind a nav item independently
 * enforces its own role in getServerSideProps (erMinRole), so a Support operator typing /operators
 * gets a real 404, not merely a missing link.
 */
import Link from 'next/link';
import { useRouter } from 'next/router';
import { signOut } from 'next-auth/react';
import { erNavFor, type OperatorRoleName } from '@/lib/operator-auth';

export default function EngineRoomLayout({ role, children }: { role: OperatorRoleName; children: React.ReactNode }) {
  const router = useRouter();
  const items = erNavFor(role);
  const isActive = (href: string) => router.pathname === href || router.pathname.startsWith(href + '/');
  const link = (active: boolean) =>
    `block p-3 rounded-lg text-sm transition ${active ? 'bg-slate-700 text-white font-medium' : 'text-slate-300 hover:bg-slate-800 hover:text-white'}`;

  return (
    <div className="min-h-screen flex bg-slate-950 text-slate-100">
      <aside className="w-64 shrink-0 bg-slate-900 border-r border-slate-800 p-4 sticky top-0 h-screen flex flex-col">
        {/* Wordmark */}
        <Link href="/superadmin" className="flex items-center gap-2 px-1 mb-6">
          <span className="w-7 h-7 rounded-md bg-slate-100 text-slate-900 font-bold flex items-center justify-center text-sm">ER</span>
          <span className="font-semibold tracking-tight">Engine Room</span>
        </Link>

        <nav className="space-y-1">
          {items.map((it) => (
            <Link key={it.href} href={it.href} className={link(isActive(it.href))}>{it.label}</Link>
          ))}
        </nav>

        {/* Settings (all roles) + Sign out, pinned at the bottom — mirrors the tenant shell. */}
        <div className="mt-auto pt-4 space-y-1 border-t border-slate-800">
          <Link href="/superadmin/settings" className={link(isActive('/superadmin/settings'))}>Settings</Link>
          <button
            onClick={() => signOut({ callbackUrl: '/superadmin/login' })}
            className="w-full text-left p-3 rounded-lg text-sm text-slate-400 hover:text-white hover:bg-slate-800 transition"
          >
            Sign out
          </button>
        </div>
      </aside>

      <main className="flex-1 min-w-0 overflow-x-auto">{children}</main>
    </div>
  );
}
