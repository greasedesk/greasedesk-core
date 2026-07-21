/**
 * File: pages/superadmin/login.tsx
 * Operator sign-in for the platform portal (SAP). Authenticates against the SEPARATE Operator
 * identity via the 'operator' NextAuth provider — a tenant User's credentials can never satisfy it
 * (different table). Deliberately unlinked from any tenant/marketing surface. The SAP pages behind
 * it 404 for any non-operator session (lib/operator-auth), so reaching this form grants nothing on
 * its own — only an Operator record does.
 */
import { useState } from 'react';
import { signIn } from 'next-auth/react';
import { useRouter } from 'next/router';
import Head from 'next/head';

export default function OperatorLogin() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const router = useRouter();

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true); setErr(null);
    const r = await signIn('operator', { redirect: false, email, password });
    setLoading(false);
    if (r?.error) setErr('Invalid email or password.');
    else router.push('/superadmin/tenants');
  };

  return (
    <>
      <Head><title>Operator sign in</title><meta name="robots" content="noindex" /></Head>
      <div className="min-h-screen flex items-center justify-center bg-slate-900 px-4">
        <div className="w-full max-w-sm bg-white rounded-2xl shadow-xl p-8">
          <h1 className="text-lg font-semibold text-slate-900 mb-1 text-center">Platform operator</h1>
          <p className="text-sm text-slate-500 text-center mb-6">Restricted access.</p>
          {err && <div className="mb-4 p-3 rounded-lg bg-red-50 text-red-700 text-sm text-center">{err}</div>}
          <form onSubmit={submit} className="space-y-4">
            <div>
              <label className="block text-sm text-slate-600 mb-1">Email</label>
              <input type="email" autoComplete="username" autoCapitalize="none" value={email} onChange={(e) => setEmail(e.target.value)} required
                className="w-full min-h-[48px] border border-slate-300 rounded-lg px-3 text-slate-900 focus:outline-none focus:ring-2 focus:ring-slate-800" />
            </div>
            <div>
              <label className="block text-sm text-slate-600 mb-1">Password</label>
              <input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required
                className="w-full min-h-[48px] border border-slate-300 rounded-lg px-3 text-slate-900 focus:outline-none focus:ring-2 focus:ring-slate-800" />
            </div>
            <button type="submit" disabled={loading} className="w-full min-h-[48px] bg-slate-900 text-white font-medium rounded-xl disabled:opacity-50">
              {loading ? 'Signing in…' : 'Sign in'}
            </button>
          </form>
        </div>
      </div>
    </>
  );
}
