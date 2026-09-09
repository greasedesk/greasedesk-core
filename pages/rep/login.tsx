/**
 * File: pages/rep/login.tsx
 * REP SIGN-IN — ask for a link. There is no password field, and there never will be.
 *
 * This page used to post an email and a password to the 'rep' credentials provider. That was
 * retracted on 2026-09-09: Rep.passwordHash is dropped, the address IS the credential, and this
 * form's only job is to ask us to send a link to it.
 *
 * IT NEVER SAYS WHETHER THE ADDRESS IS A REP. Reps are operator-created and there is no self-serve
 * signup, so the set of rep addresses is small, closed, and worth nothing to guess at — but a form
 * that answers "no such rep" is an enumeration oracle for exactly the addresses that matter, and
 * the honest sentence costs nothing.
 */
import { useState } from 'react';
import Head from 'next/head';

export default function RepLogin() {
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      await fetch('/api/rep/request-link', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      });
      // ALWAYS THE SAME OUTCOME, whatever the server found. See the header.
      setSent(true);
    } finally {
      // CLEARED IN finally: this page re-renders in place, so an unmount will never do it for us.
      setBusy(false);
    }
  };

  return (
    <>
      <Head><title>Rep sign in</title><meta name="robots" content="noindex" /></Head>
      <div className="min-h-screen flex items-center justify-center bg-emerald-950 px-4">
        <div className="w-full max-w-sm bg-white rounded-2xl shadow-xl p-8">
          <h1 className="text-lg font-semibold text-slate-900 mb-1 text-center">Rep portal</h1>
          {sent ? (
            <p className="text-sm text-slate-600 text-center mt-4" data-testid="rep-link-sent">
              If that address belongs to a rep, a sign-in link is on its way. It lasts 30 minutes and
              works once.
            </p>
          ) : (
            <>
              <p className="text-sm text-slate-500 text-center mb-6">
                Enter your email and we&apos;ll send you a sign-in link. There is no password.
              </p>
              <form onSubmit={submit} className="space-y-4">
                <div>
                  <label className="block text-sm text-slate-600 mb-1" htmlFor="rep-email">Email</label>
                  <input id="rep-email" type="email" inputMode="email" autoComplete="username" autoCapitalize="none"
                    value={email} onChange={(e) => setEmail(e.target.value)} required data-testid="rep-email"
                    className="w-full min-h-[48px] border border-slate-300 rounded-lg px-3 text-slate-900 focus:outline-none focus:ring-2 focus:ring-emerald-700" />
                </div>
                <button type="submit" disabled={busy} data-testid="rep-request"
                  className="w-full min-h-[48px] bg-emerald-700 text-white rounded-lg font-medium disabled:opacity-60">
                  {busy ? 'Sending…' : 'Send me a link'}
                </button>
              </form>
            </>
          )}
        </div>
      </div>
    </>
  );
}
