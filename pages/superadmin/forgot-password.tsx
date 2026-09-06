/**
 * File: pages/superadmin/forgot-password.tsx
 * Engine Room "forgot password" — an operator requests a reset link. Posts to the enumeration-safe
 * operator-forgot-password API and always shows the same generic confirmation (never reveals whether
 * the address exists). The reset link, when the operator exists, arrives by email and lands on
 * /superadmin/set-password.
 */
import { useState } from 'react';
import Link from 'next/link';
import Head from 'next/head';

export default function OperatorForgotPassword() {
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    await fetch('/api/superadmin/operator-forgot-password', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email }) }).catch(() => {});
    setBusy(false); setDone(true);
  };

  return (
    <>
      <Head><title>Engine Room — reset password</title><meta name="robots" content="noindex" /></Head>
      <div className="min-h-screen flex items-center justify-center bg-surface px-4">
        <div className="w-full max-w-sm bg-white rounded-2xl shadow-xl p-8">
          <h1 className="text-lg font-semibold text-ink mb-1 text-center">Reset your password</h1>
          <p className="text-sm text-muted text-center mb-6">Engine Room access</p>
          {done ? (
            <div className="p-3 rounded-lg bg-content text-ink text-sm text-center">If that operator exists, we’ve sent a reset link. Check your email.</div>
          ) : (
            <form onSubmit={submit} className="space-y-4">
              <div>
                <label className="block text-sm text-muted mb-1">Email</label>
                <input type="email" inputMode="email" autoComplete="username" autoCapitalize="none" value={email} onChange={(e) => setEmail(e.target.value)} required
                  className="w-full min-h-[48px] border border-line rounded-lg px-3 text-ink focus:outline-none focus:ring-2 focus:ring-accent" />
              </div>
              <button type="submit" disabled={busy} className="w-full min-h-[48px] bg-accent hover:bg-accent-hover text-white font-medium rounded-xl disabled:opacity-50">
                {busy ? 'Sending…' : 'Send reset link'}
              </button>
            </form>
          )}
          <div className="text-center mt-4"><Link href="/superadmin/login" className="text-sm text-muted hover:text-ink">Back to sign in</Link></div>
        </div>
      </div>
    </>
  );
}
