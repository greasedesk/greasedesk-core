/**
 * File: pages/rep/enter/[token].tsx
 * THE LINK LANDS HERE, AND NOTHING HAPPENS UNTIL A PERSON PRESSES THE BUTTON.
 *
 * ── WHY THIS IS NOT SPENT ON LOAD ───────────────────────────────────────────────────────────────
 * The obvious version signs in from a useEffect. It is wrong twice over:
 *
 *   • CORPORATE MAIL SCANNERS FOLLOW LINKS. A security appliance between our sender and the rep's
 *     inbox will GET this URL to check it. If the load spent the token, the scanner would burn the
 *     credential every time and the rep would click a dead link — a failure that looks like our bug
 *     and is invisible from our side.
 *   • React StrictMode double-invokes effects in development, so the second call would meet its own
 *     first call's consumed row and refuse. Guarding that with a ref would be application logic
 *     protecting a database rule, which is the shape this whole slice exists to avoid.
 *
 * The token is spent by the POST behind this button — NextAuth's callback endpoint, into the 'rep'
 * provider's authorize. A GET cannot reach it.
 *
 * The token is in the URL, so it is in browser history and in the Referer of anything this page
 * loads. It is single-use and thirty minutes old at most, and after the button it is spent.
 */
import { useState } from 'react';
import { useRouter } from 'next/router';
import { signIn } from 'next-auth/react';
import Head from 'next/head';
import { repSpendMessage } from '@/lib/rep-link-copy';

export default function RepEnter() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const go = async () => {
    setBusy(true); setErr(null);
    try {
      const token = String(router.query.token ?? '');
      const r = await signIn('rep', { redirect: false, token });
      if (r?.error) {
        // The provider throws REP_LINK_<reason>; anything else is NextAuth's own.
        const reason = r.error.startsWith('REP_LINK_') ? r.error.slice('REP_LINK_'.length) : 'not_found';
        setErr(repSpendMessage(reason as any));
        return;
      }
      await router.push('/rep');
    } finally {
      // CLEARED IN finally. A successful sign-in replaces the route without unmounting this
      // component, so an unmount will never clear it for us — the busy-flag rule, same as the
      // save handlers.
      setBusy(false);
    }
  };

  return (
    <>
      <Head><title>Sign in</title><meta name="robots" content="noindex" /></Head>
      <div className="min-h-screen flex items-center justify-center bg-emerald-950 px-4">
        <div className="w-full max-w-sm bg-white rounded-2xl shadow-xl p-8 text-center">
          <h1 className="text-lg font-semibold text-slate-900 mb-1">Rep portal</h1>
          {err ? (
            <>
              <p className="text-sm text-red-700 mt-4" data-testid="rep-enter-error">{err}</p>
              <a href="/rep/login" className="inline-block mt-6 text-sm text-emerald-700 underline">Ask for a new link</a>
            </>
          ) : (
            <>
              <p className="text-sm text-slate-500 mt-1 mb-6">Press to finish signing in. This link works once.</p>
              <button onClick={go} disabled={busy} data-testid="rep-enter"
                className="w-full min-h-[48px] bg-emerald-700 text-white rounded-lg font-medium disabled:opacity-60">
                {busy ? 'Signing in…' : 'Sign in'}
              </button>
            </>
          )}
        </div>
      </div>
    </>
  );
}
