/**
 * File: pages/rep/login.tsx
 * Rep sign-in for the field-sales PWA. Authenticates against the SEPARATE Rep identity via the
 * 'rep' NextAuth provider. The rep portal behind it 404s for any non-rep session. The phone-first
 * PWA shell + the agreement gate land in the rep-portal layer; this is the auth entry point only.
 */
import { useState } from 'react';
import { signIn } from 'next-auth/react';
import { useRouter } from 'next/router';
import Head from 'next/head';

export default function RepLogin() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const router = useRouter();

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true); setErr(null);
    const r = await signIn('rep', { redirect: false, email, password });
    setLoading(false);
    if (r?.error) setErr('Invalid email or password.');
    else router.push('/rep');
  };

  return (
    <>
      <Head><title>Rep sign in</title><meta name="robots" content="noindex" /></Head>
      <div className="min-h-screen flex items-center justify-center bg-emerald-950 px-4">
        <div className="w-full max-w-sm bg-white rounded-2xl shadow-xl p-8">
          <h1 className="text-lg font-semibold text-slate-900 mb-1 text-center">Rep portal</h1>
          <p className="text-sm text-slate-500 text-center mb-6">Sign in to see your earnings.</p>
          {err && <div className="mb-4 p-3 rounded-lg bg-red-50 text-red-700 text-sm text-center">{err}</div>}
          <form onSubmit={submit} className="space-y-4">
            <div>
              <label className="block text-sm text-slate-600 mb-1">Email</label>
              <input type="email" inputMode="email" autoComplete="username" autoCapitalize="none" value={email} onChange={(e) => setEmail(e.target.value)} required
                className="w-full min-h-[48px] border border-slate-300 rounded-lg px-3 text-slate-900 focus:outline-none focus:ring-2 focus:ring-emerald-700" />
            </div>
            <div>
              <label className="block text-sm text-slate-600 mb-1">Password</label>
              <input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required
                className="w-full min-h-[48px] border border-slate-300 rounded-lg px-3 text-slate-900 focus:outline-none focus:ring-2 focus:ring-emerald-700" />
            </div>
            <button type="submit" disabled={loading} className="w-full min-h-[48px] bg-emerald-700 text-white font-medium rounded-xl disabled:opacity-50">
              {loading ? 'Signing in…' : 'Sign in'}
            </button>
          </form>
        </div>
      </div>
    </>
  );
}
