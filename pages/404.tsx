/**
 * File: pages/404.tsx
 * Custom not-found (ruling 2026-07-14): a wrong or cross-tenant URL returns a clean 404 — the
 * session stays intact — but a BARE Next default 404 reads as a crash/logout. This is a
 * self-contained, branded page (a notFound for an /admin route renders OUTSIDE the admin shell,
 * so it can rely on nothing) that says plainly "this doesn't belong to your account", with a way back.
 *
 * ── ONE PAGE, THREE HOSTS, THREE AUDIENCES (2026-09-09) ─────────────────────────────────────────
 * It said "You're still signed in — nothing's wrong with your session." That sentence was written
 * for a tenant who mistyped a URL inside the app, and it was doing real work there: the whole
 * ruling above exists because a bare 404 reads as having been logged out.
 *
 * But this page holds NO SESSION DATA and never has. The claim was a guess that happened to be
 * right for one audience, and once er. and reps. existed it was being told to two others — on the
 * rep host, to a stranger with no account at all, who is informed their session is fine.
 *
 * SO THE REASSURANCE IS NOW A STATEMENT ABOUT WHAT THIS PAGE DID, not about what the reader has.
 * "Nothing was changed and nobody was signed out" is true for all three audiences, needs no session
 * to know, and still answers the fear the ruling was written for. rep-host-gate holds it.
 *
 * The destination is host-aware for the same reason: "Back to dashboard" is a dead end for a rep.
 * Read on the CLIENT, because a 404 renders outside every layout and has no server props of its own
 * — the same place, and the same reason, the path was already being read.
 */
import { useEffect, useState } from 'react';
import Head from 'next/head';
import Link from 'next/link';

type Audience = 'tenant' | 'rep' | 'operator' | 'public';

export default function NotFound() {
  // DEFAULTS TO 'tenant' — the audience this page has always served, and the one whose journey the
  // ruling above is about. A first paint before the effect runs must not show a rep the wrong door.
  const [who, setWho] = useState<Audience>('tenant');
  useEffect(() => {
    try {
      // The browser URL stays the requested path on a notFound, so both halves are readable here.
      const host = window.location.hostname.toLowerCase();
      const path = window.location.pathname;
      if (host.startsWith('reps.')) setWho('rep');
      else if (host.startsWith('er.')) setWho('operator');
      else setWho(path.startsWith('/admin') ? 'tenant' : 'public');
    } catch { /* keep the default */ }
  }, []);

  const back = {
    tenant: { href: '/admin/dashboard', label: 'Back to dashboard' },
    rep: { href: '/', label: 'Back to the rep portal' },
    operator: { href: '/superadmin', label: 'Back to the Engine Room' },
    public: { href: '/', label: 'Back to home' },
  }[who];

  return (
    <>
      <Head><title>Not found — GreaseDesk</title></Head>
      <main className="min-h-screen flex items-center justify-center p-6 bg-sidebar text-sidebar-fg">
        <div className="max-w-md w-full text-center rounded-2xl p-8 bg-surface border border-line" data-testid="not-found">
          <div className="text-5xl mb-4">🔧</div>
          <h1 className="text-2xl font-semibold mb-2 text-ink">Not found</h1>
          <p className="text-sm text-muted mb-6">
            This page doesn’t exist, or it doesn’t belong to your account. Nothing was changed and
            nobody was signed out.
          </p>
          <Link href={back.href} className="inline-block rounded-lg px-5 py-2.5 text-sm font-medium text-white bg-accent hover:bg-accent-hover">
            {back.label}
          </Link>
          {/* A GARAGE THAT HITS A DEAD LINK HAS A PROBLEM AND NOWHERE TO SAY SO. Only offered to a
              signed-in tenant: /admin/support would bounce anyone else to the login screen, which
              is a worse dead end than the one they just hit — and on the rep host it does not
              exist at all, because middleware 404s every tenant route there. */}
          {who === 'tenant' && (
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
