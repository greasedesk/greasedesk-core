/**
 * File: pages/affiliate-portal/enter/[token].tsx — served at /enter/<token> on affiliates.greasedesk.com.
 * THE LINK LANDS HERE, AND NOTHING HAPPENS UNTIL A PERSON PRESSES THE BUTTON.
 *
 * The reasoning is pages/rep/enter/[token].tsx's, unchanged and worth not re-deriving: a corporate
 * mail scanner GETs the URL to check it, and spending the token on load would burn the credential
 * before the affiliate ever clicked — a failure that looks like our bug and is invisible from our
 * side. React StrictMode's double-invoked effects would do the same thing in development.
 *
 * ── IT SIGNS IN THROUGH THE SAME PROVIDER AS A REP, AND THAT IS CORRECT ─────────────────────────
 * An affiliate IS a Rep row (party_type: 'affiliate') with the same credential mechanism, so there
 * is one provider, one token table and one 24-hour session floor. What differs is only where they
 * land, and that comes from lib/party-portal rather than from a string here.
 */
import { useState } from 'react';
import { useRouter } from 'next/router';
import { signIn } from 'next-auth/react';
import Head from 'next/head';
import { repSpendMessage } from '@/lib/rep-link-copy';
import { portalHomePath, portalSignInPath } from '@/lib/party-portal';

export default function AffiliateEnter() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const go = async () => {
    setBusy(true); setErr(null);
    try {
      const token = String(router.query.token ?? '');
      const r = await signIn('rep', { redirect: false, token });
      if (r?.error) {
        const reason = r.error.startsWith('REP_LINK_') ? r.error.slice('REP_LINK_'.length) : 'not_found';
        setErr(repSpendMessage(reason as any));
        return;
      }
      await router.push(portalHomePath('affiliate'));
    } finally {
      // CLEARED IN finally. A successful sign-in replaces the route without unmounting this
      // component, so an unmount will never clear it for us — the busy-flag rule.
      setBusy(false);
    }
  };

  return (
    <>
      <Head><title>Sign in — GreaseDesk affiliates</title><meta name="robots" content="noindex" /></Head>
      <main className="min-h-screen bg-canvas flex items-center justify-center px-4 py-12">
        <div className="w-full max-w-sm bg-surface border border-line rounded-2xl shadow-card p-6 sm:p-8 text-center">
          <h1 className="text-lg font-semibold text-ink">GreaseDesk affiliates</h1>
          {err ? (
            <>
              <p className="text-sm text-danger mt-4" data-testid="affiliate-enter-error">{err}</p>
              <a href={portalSignInPath('affiliate')} className="inline-block mt-6 text-sm text-accent hover:underline">
                Ask for a new link
              </a>
            </>
          ) : (
            <>
              <p className="text-sm text-muted mt-2 mb-6">Press to finish signing in. This link works once.</p>
              <button onClick={go} disabled={busy} data-testid="affiliate-enter"
                className="w-full min-h-[48px] bg-accent hover:bg-accent-hover text-white rounded-lg font-semibold disabled:opacity-60 transition-colors">
                {busy ? 'Signing in…' : 'Sign in'}
              </button>
            </>
          )}
        </div>
      </main>
    </>
  );
}
