/**
 * File: pages/404.tsx
 * Custom not-found (ruling 2026-07-14): a wrong or cross-tenant URL returns a clean 404 — the
 * session stays intact — but a BARE Next default 404 reads as a crash/logout. This is a
 * self-contained, branded page (a notFound for an /admin route renders OUTSIDE the admin shell,
 * so it can rely on nothing) that says plainly "this doesn't belong to your account", with a way
 * back. No session is touched; the user is not logged out.
 */
import { useEffect, useState } from 'react';
import Head from 'next/head';
import Link from 'next/link';

export default function NotFound() {
  const [isAdmin, setIsAdmin] = useState(true);
  useEffect(() => {
    // The browser URL stays the requested path on a notFound — tailor the "back" target to it.
    try { setIsAdmin(window.location.pathname.startsWith('/admin')); } catch { /* default admin */ }
  }, []);
  return (
    <>
      <Head><title>Not found — GreaseDesk</title></Head>
      <main className="min-h-screen flex items-center justify-center p-6 bg-sidebar text-sidebar-fg">
        <div className="max-w-md w-full text-center rounded-2xl p-8 bg-surface border border-line">
          <div className="text-5xl mb-4">🔧</div>
          <h1 className="text-2xl font-semibold mb-2 text-ink">Not found</h1>
          <p className="text-sm text-muted mb-6">This page doesn’t exist, or it doesn’t belong to your account. You’re still signed in — nothing’s wrong with your session.</p>
          <Link href={isAdmin ? '/admin/dashboard' : '/'} className="inline-block rounded-lg px-5 py-2.5 text-sm font-medium text-white bg-accent hover:bg-accent-hover">
            {isAdmin ? 'Back to dashboard' : 'Back to home'}
          </Link>
          {/* A GARAGE THAT HITS A DEAD LINK HAS A PROBLEM AND NOWHERE TO SAY SO. Only offered to a
              signed-in tenant: /admin/support would bounce anyone else to the login screen, which
              is a worse dead end than the one they just hit. */}
          {isAdmin && (
            <p className="text-sm text-muted mt-5">
              Expected something here?{' '}
              <Link href="/admin/support" className="text-accent hover:underline">Tell us</Link>.
            </p>
          )}
        </div>
      </main>
    </>
  );
}
