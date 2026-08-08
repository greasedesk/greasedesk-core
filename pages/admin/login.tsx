/**
 * File: pages/admin/login.tsx
 * Last edited: 2025-11-03 at 17:46
 *
 * This is the unified login page for all STAFF/ADMIN users (including garage owner).
 * FIX: Added Link import for navigation component.
 */
import { useState } from 'react';
import { signIn, getCsrfToken } from 'next-auth/react';
import { useRouter } from 'next/router';
import Head from 'next/head';
import SiteChrome from '@/components/marketing/SiteChrome';
import Link from 'next/link'; // <<< CRITICAL FIX: ADDED IMPORT

// We get the CSRF token on the server side to secure the form
export async function getServerSideProps(context: any) {
  return {
    props: {
      csrfToken: await getCsrfToken(context),
      // Read the error or email query parameters if they exist
      error: context.query.error || null,
      email: context.query.email || null,
      status: context.query.status || null,
      // RELATIVE paths only — a crafted ?callbackUrl=https://evil.example must never win.
      callbackUrl: (typeof context.query.callbackUrl === 'string' && context.query.callbackUrl.startsWith('/') && !context.query.callbackUrl.startsWith('//'))
        ? context.query.callbackUrl
        : '/admin/landing',
    },
  };
}

export default function AdminLoginPage({ csrfToken, error, email, status, callbackUrl }: { csrfToken: string, error: string | null, email: string | null, status: string | null, callbackUrl: string }) {
  const [loginEmail, setLoginEmail] = useState(email || '');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false); // oily-thumb reveal — typos are the norm in a workshop
  const [loading, setLoading] = useState(false);
  // ── SECOND FACTOR. `needCode` is answered by a PREFLIGHT rather than by failing a sign-in: the
  // NextAuth credentials flow is one-shot, so without it the only way to discover a code is wanted
  // is a rejection that looks exactly like a wrong password. Telling someone their correct password
  // was refused is the worst version of this screen.
  const [needCode, setNeedCode] = useState(false);
  const [totp, setTotp] = useState('');
  const [codeError, setCodeError] = useState<string | null>(null);
  const router = useRouter();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setCodeError(null);

    // Ask FIRST, before spending a sign-in attempt, unless we are already on the code step.
    if (!needCode) {
      try {
        const pf = await fetch('/api/account/2fa-preflight', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: loginEmail, password }),
        });
        const d = await pf.json().catch(() => ({}));
        if (d?.twoFactorRequired) { setNeedCode(true); setLoading(false); return; }
      } catch { /* preflight is an optimisation — a failure just means the sign-in below asks */ }
    }

    const result = await signIn('credentials', {
      redirect: false,
      email: loginEmail,
      password: password,
      totp: totp.trim(),
      callbackUrl: callbackUrl, // Use the destination we passed
    });

    setLoading(false);

    if (result && result.error) {
      // A 2FA refusal is NOT a credentials failure and must not be reported as one — bouncing to
      // "invalid email or password" would send someone resetting a password that is correct.
      if (result.error.includes('TWO_FACTOR_LOCKED')) {
        setNeedCode(true); setTotp('');
        setCodeError('Too many incorrect codes. Wait 15 minutes and try again.');
        return;
      }
      if (result.error.includes('TWO_FACTOR_REQUIRED')) {
        setNeedCode(true); setTotp('');
        setCodeError(totp.trim() ? 'That code didn’t match. Try the current one from your app.' : null);
        return;
      }
      // Keep the callbackUrl through the retry — a failed first try at /m must still return to /m.
      router.push(`/admin/login?error=InvalidCredentials&callbackUrl=${encodeURIComponent(callbackUrl)}`);
    } else if (result && result.url) {
      router.push(result.url);
    }
  };

  const getErrorMessage = () => {
    if (error === 'InvalidCredentials') {
      return 'Invalid email or password.';
    }
    if (status === 'verified') {
      return 'Email verified! Please enter your password to continue.';
    }
    // Fallback landing when the post-change silent re-auth didn't take: say why they're here.
    if (status === 'password-changed') {
      return 'Password changed. Please sign in with your new password.';
    }
    if (status === 'signed-out-everywhere') {
      return 'You’ve been signed out on all devices. Sign in to continue.';
    }
    return null;
  };

  return (
    <>
      <Head>
        <title>Sign in - GreaseDesk</title>
      </Head>
      <SiteChrome>
      <div className="max-w-md mx-auto px-4 sm:px-6 pt-10 sm:pt-14 pb-16">
        <div className="bg-surface border border-line rounded-2xl shadow-card p-8">
          
          <h1 className="text-xl font-semibold text-ink mb-6 text-center">
            Sign in
          </h1>

          <p className="text-sm text-muted text-center mb-6">
            Sign in to manage your job cards and garage operations.
          </p>

          {/* Error/Status Message Display */}
          {getErrorMessage() && (
            <div className={`p-3 rounded-lg text-center mb-4 ${status === 'verified' || status === 'password-changed' || status === 'signed-out-everywhere' ? 'bg-ok-soft text-ok' : 'bg-danger-soft text-danger'}`}>
              <p className="text-sm">{getErrorMessage()}</p>
            </div>
          )}

          <form onSubmit={handleSubmit} className="space-y-4">
            <input name="csrfToken" type="hidden" defaultValue={csrfToken} /> 
            
            {/* Phone-first fields: email keyboard + password-manager hints, no autocapitalise,
                reveal toggle, ≥48px touch targets — this form gets used with gloves on. */}
            <div>
              <label htmlFor="login-email" className="block text-sm font-medium text-muted mb-1">Email</label>
              <input
                id="login-email"
                type="email"
                inputMode="email"
                autoComplete="username"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                value={loginEmail}
                onChange={(e) => setLoginEmail(e.target.value)}
                required
                className="w-full min-h-[48px] bg-surface border border-line rounded-lg px-3 py-2 text-base text-ink focus:outline-none focus:ring-2 focus:ring-accent"
              />
            </div>

            <div>
              <div className="flex items-baseline justify-between mb-1">
                <label htmlFor="login-password" className="block text-sm font-medium text-muted">Password</label>
                {/* THE entry point that was missing — a locked-out owner previously had no route back. */}
                <Link href="/forgot-password" className="text-sm text-accent hover:underline">Forgotten your password?</Link>
              </div>
              <div className="relative">
                <input
                  id="login-password"
                  type={showPassword ? 'text' : 'password'}
                  autoComplete="current-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                  className="w-full min-h-[48px] bg-surface border border-line rounded-lg pl-3 pr-16 py-2 text-base text-ink focus:outline-none focus:ring-2 focus:ring-accent"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword((v) => !v)}
                  aria-label={showPassword ? 'Hide password' : 'Show password'}
                  className="absolute inset-y-0 right-0 min-w-[56px] px-3 text-sm text-muted hover:text-ink"
                >
                  {showPassword ? 'Hide' : 'Show'}
                </button>
              </div>
            </div>

            {/* THE CODE STEP. Appears only once the password has verified and the account has 2FA
                on, so it is never a puzzle for the 99% who don't. The recovery-code route is named
                here rather than hidden behind a link — someone who has lost their phone is already
                having a bad morning. */}
            {needCode && (
              <div data-testid="totp-step">
                <label htmlFor="login-totp" className="block text-sm font-medium text-muted">Enter your authenticator code</label>
                <p className="text-xs text-muted mt-1 mb-2">
                  Open your authenticator app and enter the 6-digit code for GreaseDesk.
                  Lost your phone? Enter one of your recovery codes instead.
                </p>
                <input
                  id="login-totp"
                  name="totp"
                  type="text"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  autoFocus
                  value={totp}
                  onChange={(e) => setTotp(e.target.value)}
                  className="w-full min-h-[48px] bg-surface border border-line rounded-xl px-4 py-3 text-ink focus:ring-2 focus:ring-accent focus:outline-none"
                  placeholder="6-digit code"
                />
                {codeError && <p className="mt-2 text-sm text-danger" data-testid="totp-error">{codeError}</p>}
              </div>
            )}

            <button
              type="submit"
              disabled={loading || (needCode && !totp.trim())}
              className="w-full min-h-[48px] bg-accent text-white font-medium rounded-xl px-4 py-3 disabled:opacity-50 flex items-center justify-center gap-2"
            >
              {loading && <LoadingSpinner />}
              {loading ? 'Signing in…' : needCode ? 'Verify and sign in' : 'Sign in'}
            </button>
          </form>

          <div className="text-center mt-6">
            <Link href="/register" className="text-sm text-muted hover:text-accent">
              Don't have a garage account? Register here.
            </Link>
          </div>
        </div>
      </div>
      </SiteChrome>
    </>
  );
}

// Simple SVG for the loading spinner
const LoadingSpinner = () => (
    <svg 
      className="animate-spin h-5 w-5 text-white" 
      xmlns="http://www.w3.org/2000/svg" 
      fill="none" 
      viewBox="0 0 24 24"
    >
      <circle 
        className="opacity-25" 
        cx="12" 
        cy="12" 
        r="10" 
        stroke="currentColor" 
        strokeWidth="4" 
      />
      <path 
        className="opacity-75" 
        fill="currentColor" 
        d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" 
      />
    </svg>
  );
