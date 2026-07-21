/**
 * File: pages/superadmin/set-password.tsx
 * Public operator set-password page (reached from the emailed invite link, /superadmin/set-password
 * ?token=…). Posts the token + new password to the operator-set-password API; on success sends the
 * operator to the Engine Room login. No session required — the token is the credential.
 */
import { useState } from 'react';
import { useRouter } from 'next/router';
import Head from 'next/head';

export default function OperatorSetPassword() {
  const router = useRouter();
  const token = typeof router.query.token === 'string' ? router.query.token : '';
  const [pw, setPw] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true); setErr(null);
    const r = await fetch('/api/superadmin/operator-set-password', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, newPassword: pw, confirmPassword: confirm }),
    });
    const data = await r.json().catch(() => ({}));
    setBusy(false);
    if (!r.ok) { setErr(data.message || 'Could not set your password.'); return; }
    setDone(true);
    setTimeout(() => router.push('/superadmin/login'), 1200);
  };

  return (
    <>
      <Head><title>Engine Room — set password</title><meta name="robots" content="noindex" /></Head>
      <div className="min-h-screen flex items-center justify-center bg-slate-900 px-4">
        <div className="w-full max-w-sm bg-white rounded-2xl shadow-xl p-8">
          <h1 className="text-lg font-semibold text-slate-900 mb-1 text-center">Set your password</h1>
          <p className="text-sm text-slate-500 text-center mb-6">Engine Room access</p>
          {done ? (
            <div className="p-3 rounded-lg bg-green-50 text-green-700 text-sm text-center">Password set. Redirecting to sign in…</div>
          ) : (
            <form onSubmit={submit} className="space-y-4">
              {err && <div className="p-3 rounded-lg bg-red-50 text-red-700 text-sm text-center">{err}</div>}
              <div>
                <label className="block text-sm text-slate-600 mb-1">New password</label>
                <input type="password" autoComplete="new-password" value={pw} onChange={(e) => setPw(e.target.value)} required minLength={8}
                  className="w-full min-h-[48px] border border-slate-300 rounded-lg px-3 text-slate-900 focus:outline-none focus:ring-2 focus:ring-slate-800" />
              </div>
              <div>
                <label className="block text-sm text-slate-600 mb-1">Confirm password</label>
                <input type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} required minLength={8}
                  className="w-full min-h-[48px] border border-slate-300 rounded-lg px-3 text-slate-900 focus:outline-none focus:ring-2 focus:ring-slate-800" />
              </div>
              <button type="submit" disabled={busy || !token} className="w-full min-h-[48px] bg-slate-900 text-white font-medium rounded-xl disabled:opacity-50">
                {busy ? 'Saving…' : 'Set password'}
              </button>
            </form>
          )}
        </div>
      </div>
    </>
  );
}
