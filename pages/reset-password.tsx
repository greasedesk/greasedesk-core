/**
 * File: pages/reset-password.tsx
 * Set a new password from a reset link (?token=). The token IS the credential — this page only
 * carries it; /api/auth/reset-password re-validates it server-side and never trusts this screen.
 * On success every session issued before now is dead (sessions_valid_from), so the user signs in fresh.
 */
import { useState } from 'react';
import Link from 'next/link';
import Head from 'next/head';
import { useRouter } from 'next/router';
import SiteChrome from '@/components/marketing/SiteChrome';

const inputCls = 'w-full p-3 bg-surface border border-line rounded-lg text-ink text-sm focus:ring-2 focus:ring-accent focus:border-accent outline-none';

export default function ResetPasswordPage() {
  const router = useRouter();
  const token = typeof router.query.token === 'string' ? router.query.token : '';
  const [pw, setPw] = useState('');
  const [cf, setCf] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    if (pw.length < 8) { setErr('Password must be at least 8 characters long.'); return; }
    if (pw !== cf) { setErr('Those passwords don’t match.'); return; }
    setBusy(true);
    try {
      const res = await fetch('/api/auth/reset-password', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, newPassword: pw, confirmPassword: cf }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data?.ok) setDone(true);
      else setErr(data?.message || 'Could not reset your password. Please request a new link.');
    } catch {
      setErr('We couldn’t reach the server. Please try again.');
    } finally { setBusy(false); }
  }

  return (
    <>
      <Head><title>Set a new password - GreaseDesk</title><meta name="robots" content="noindex" /></Head>
      <SiteChrome>
        <div className="max-w-md mx-auto px-4 sm:px-6 pt-10 sm:pt-14 pb-16">
          <div className="bg-surface border border-line rounded-2xl shadow-card p-8">
            {done ? (
              <div className="text-center">
                <div className="text-3xl mb-2" aria-hidden="true">✅</div>
                <h1 className="text-xl font-semibold text-ink mb-2">Password updated</h1>
                <p className="text-sm text-muted">For security, you’ve been signed out on every device. Sign in with your new password.</p>
                <Link href="/admin/login" className="mt-6 inline-block bg-accent hover:bg-accent-hover text-white font-semibold rounded-xl px-5 py-3">Sign in</Link>
              </div>
            ) : !token ? (
              <div className="text-center">
                <h1 className="text-xl font-semibold text-ink mb-2">This link isn’t valid</h1>
                <p className="text-sm text-muted">Reset links expire after 1 hour and can be used once.</p>
                <Link href="/forgot-password" className="mt-6 inline-block text-sm text-accent hover:underline">Request a new link</Link>
              </div>
            ) : (
              <>
                <h1 className="text-xl font-semibold text-ink mb-6 text-center">Set a new password</h1>
                {err && <div className="bg-danger-soft text-danger rounded-lg p-3 text-sm mb-4">{err}</div>}
                <form onSubmit={submit} className="space-y-4" noValidate>
                  <div>
                    <label htmlFor="rp-pw" className="block text-sm font-medium text-muted mb-1">New password (min 8 characters)</label>
                    <input id="rp-pw" type="password" className={inputCls} value={pw} onChange={(e) => setPw(e.target.value)} required autoComplete="new-password" autoFocus />
                  </div>
                  <div>
                    <label htmlFor="rp-cf" className="block text-sm font-medium text-muted mb-1">Confirm password</label>
                    <input id="rp-cf" type="password" className={inputCls} value={cf} onChange={(e) => setCf(e.target.value)} required autoComplete="new-password" />
                  </div>
                  <button type="submit" disabled={busy} className="w-full bg-accent hover:bg-accent-hover text-white font-semibold rounded-xl px-4 py-3 disabled:opacity-60">
                    {busy ? 'Saving…' : 'Set password'}
                  </button>
                </form>
              </>
            )}
          </div>
        </div>
      </SiteChrome>
    </>
  );
}
