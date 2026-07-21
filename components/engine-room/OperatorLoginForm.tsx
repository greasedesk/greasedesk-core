/**
 * File: components/engine-room/OperatorLoginForm.tsx
 * The Engine Room operator sign-in form, shared by the bare root (er.greasedesk.com/, rendered by the
 * front-door index for logged-out visitors) and /superadmin/login. Signs in via the 'operator'
 * provider (redirect:false, on-origin), then returns to the front door which routes to the role's
 * landing. Carries the "Forgot password?" entry point to the operator reset flow.
 *
 * TWO-FACTOR: after email+password, a lightweight preflight asks whether this account has 2FA on. If
 * so, we reveal an authenticator-code field and sign in WITH the code. The preflight is only UX — the
 * operator authorize() enforces the second factor server-side regardless.
 */
import { useState } from 'react';
import Link from 'next/link';
import { signIn } from 'next-auth/react';
import { useRouter } from 'next/router';

export default function OperatorLoginForm() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [needCode, setNeedCode] = useState(false);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const router = useRouter();

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true); setErr(null);
    try {
      // First pass: does this account need a second factor? (Reveal the code field before signing in.)
      if (!needCode) {
        const pf = await fetch('/api/superadmin/2fa-preflight', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }),
        }).then((r) => r.json()).catch(() => ({}));
        if (pf?.twoFactorRequired) { setNeedCode(true); setLoading(false); return; }
      }
      const r = await signIn('operator', { redirect: false, email, password, totp: needCode ? code : undefined });
      setLoading(false);
      if (r?.error) setErr(needCode ? 'Invalid code — check your authenticator app, or enter a recovery code.' : 'Invalid email or password.');
      else router.push('/superadmin'); // front door → role landing
    } catch {
      setLoading(false); setErr('Something went wrong. Please try again.');
    }
  };

  const inputCls = 'w-full min-h-[48px] border border-slate-300 rounded-lg px-3 text-slate-900 focus:outline-none focus:ring-2 focus:ring-slate-800';

  return (
    <div className="min-h-screen flex items-center justify-center bg-slate-900 px-4">
      <div className="w-full max-w-sm bg-white rounded-2xl shadow-xl p-8">
        <h1 className="text-lg font-semibold text-slate-900 mb-1 text-center">Engine Room</h1>
        <p className="text-sm text-slate-500 text-center mb-6">Restricted access.</p>
        {err && <div className="mb-4 p-3 rounded-lg bg-red-50 text-red-700 text-sm text-center">{err}</div>}
        <form onSubmit={submit} className="space-y-4">
          <div>
            <label className="block text-sm text-slate-600 mb-1">Email</label>
            <input type="email" autoComplete="username" autoCapitalize="none" value={email} disabled={needCode} onChange={(e) => setEmail(e.target.value)} required className={`${inputCls} disabled:bg-slate-50 disabled:text-slate-500`} />
          </div>
          <div>
            <label className="block text-sm text-slate-600 mb-1">Password</label>
            <input type="password" autoComplete="current-password" value={password} disabled={needCode} onChange={(e) => setPassword(e.target.value)} required className={`${inputCls} disabled:bg-slate-50 disabled:text-slate-500`} />
          </div>
          {needCode && (
            <div>
              <label className="block text-sm text-slate-600 mb-1">Authenticator code</label>
              <input type="text" inputMode="numeric" autoComplete="one-time-code" autoFocus value={code} onChange={(e) => setCode(e.target.value)} required placeholder="6-digit code or recovery code" className={inputCls} />
              <p className="text-xs text-slate-500 mt-1">Lost your device? Enter one of your recovery codes instead.</p>
            </div>
          )}
          <button type="submit" disabled={loading} className="w-full min-h-[48px] bg-slate-900 text-white font-medium rounded-xl disabled:opacity-50">
            {loading ? 'Signing in…' : needCode ? 'Verify code' : 'Sign in'}
          </button>
        </form>
        <div className="text-center mt-4">
          <Link href="/superadmin/forgot-password" className="text-sm text-slate-500 hover:text-slate-800">Forgot password?</Link>
        </div>
      </div>
    </div>
  );
}
