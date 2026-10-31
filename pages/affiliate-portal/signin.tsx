/**
 * File: pages/affiliate-portal/signin.tsx — served at /signin on affiliates.greasedesk.com.
 * ASK FOR A LINK. There is no password field, and there never will be.
 *
 * ── IT NEVER SAYS WHETHER THE ADDRESS IS AN AFFILIATE ───────────────────────────────────────────
 * The rep version of this page can argue that rep addresses are a small closed set worth protecting.
 * Here the argument is stronger, not weaker: affiliates SELF-SERVE SIGN UP, so anybody can type an
 * address into /join and ask this page whether it came back. A form that answered "no such
 * affiliate" would be a free oracle for which of your competitors, customers or neighbours is on the
 * programme. One sentence, every time.
 */
import { useState } from 'react';
import Head from 'next/head';

export default function AffiliateSignIn() {
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      await fetch('/api/affiliate-portal/request-link', {
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
      <Head><title>Sign in — GreaseDesk affiliates</title><meta name="robots" content="noindex" /></Head>
      <main className="min-h-screen bg-canvas flex items-center justify-center px-4 py-12">
        <div className="w-full max-w-sm bg-surface border border-line rounded-2xl shadow-card p-6 sm:p-8">
          <h1 className="text-lg font-semibold text-ink text-center">Affiliate sign in</h1>
          {sent ? (
            <p className="text-sm text-muted text-center mt-4" data-testid="affiliate-link-sent">
              If that address belongs to an affiliate, a sign-in link is on its way. It lasts 30 minutes
              and works once.
            </p>
          ) : (
            <>
              <p className="text-sm text-muted text-center mt-2 mb-6">
                Enter your email and we&apos;ll send you a sign-in link. There is no password.
              </p>
              <form onSubmit={submit} className="space-y-4">
                <div>
                  <label className="block text-sm text-ink mb-1" htmlFor="affiliate-email">Email</label>
                  <input id="affiliate-email" type="email" inputMode="email" autoComplete="username" autoCapitalize="none"
                    value={email} onChange={(e) => setEmail(e.target.value)} required data-testid="affiliate-email"
                    className="w-full min-h-[48px] border border-line rounded-lg px-3 text-ink bg-surface focus:outline-none focus:ring-2 focus:ring-accent" />
                </div>
                <button type="submit" disabled={busy} data-testid="affiliate-request"
                  className="w-full min-h-[48px] bg-accent hover:bg-accent-hover text-white rounded-lg font-semibold disabled:opacity-60 transition-colors">
                  {busy ? 'Sending…' : 'Send me a link'}
                </button>
              </form>
            </>
          )}
          <p className="mt-6 text-xs text-muted text-center">
            Not an affiliate yet? <a href="/join" className="text-accent hover:underline">Join the programme</a>
          </p>
        </div>
      </main>
    </>
  );
}
