/**
 * File: pages/forgot-password.tsx
 * Request a password-reset link. The entry point that was missing — an ADMIN owner who forgets
 * their password previously had no route back into their own account.
 * ENUMERATION-SAFE: the confirmation is identical whether or not the address is registered, so this
 * screen must never imply "we found you" — the copy says "if that address is registered".
 */
import { useState } from 'react';
import Link from 'next/link';
import Head from 'next/head';
import SiteChrome from '@/components/marketing/SiteChrome';
import { COMPANY } from '@/lib/company-info';

const inputCls = 'w-full p-3 bg-surface border border-line rounded-lg text-ink text-sm focus:ring-2 focus:ring-accent focus:border-accent outline-none';

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState('');
  const [state, setState] = useState<'idle' | 'sending' | 'sent'>('idle');

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setState('sending');
    try {
      await fetch('/api/auth/forgot-password', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email }),
      });
    } catch { /* the confirmation is identical either way — never leak a failure signal */ }
    setState('sent');
  }

  return (
    <>
      <Head><title>Reset your password - GreaseDesk</title><meta name="robots" content="noindex" /></Head>
      <SiteChrome>
        <div className="max-w-md mx-auto px-4 sm:px-6 pt-10 sm:pt-14 pb-16">
          <div className="bg-surface border border-line rounded-2xl shadow-card p-8">
            {state === 'sent' ? (
              <div className="text-center">
                <div className="text-3xl mb-2" aria-hidden="true">📧</div>
                <h1 className="text-xl font-semibold text-ink mb-2">Check your email</h1>
                <p className="text-sm text-muted">
                  If that address is registered, we’ve sent a link to set a new password. It expires in 1 hour.
                </p>
                <p className="mt-4 text-xs text-muted">
                  Nothing arrived? Check spam, or call us on{' '}
                  <a href={`tel:${COMPANY.phoneE164}`} className="text-accent hover:underline">{COMPANY.phone}</a>.
                </p>
                <Link href="/admin/login" className="mt-6 inline-block text-sm text-accent hover:underline">Back to sign in</Link>
              </div>
            ) : (
              <>
                <h1 className="text-xl font-semibold text-ink mb-2 text-center">Reset your password</h1>
                <p className="text-sm text-muted mb-6 text-center">Enter the email address you sign in with and we’ll send you a link.</p>
                <form onSubmit={submit} className="space-y-4" noValidate>
                  <div>
                    <label htmlFor="fp-email" className="block text-sm font-medium text-muted mb-1">Email</label>
                    <input id="fp-email" type="email" className={inputCls} value={email} onChange={(e) => setEmail(e.target.value)} required maxLength={200} autoComplete="email" autoFocus />
                  </div>
                  <button type="submit" disabled={state === 'sending'} className="w-full bg-accent hover:bg-accent-hover text-white font-semibold rounded-xl px-4 py-3 disabled:opacity-60">
                    {state === 'sending' ? 'Sending…' : 'Send reset link'}
                  </button>
                </form>
                <p className="mt-6 text-center text-sm text-muted">
                  Remembered it? <Link href="/admin/login" className="text-accent hover:underline">Sign in</Link>
                </p>
              </>
            )}
          </div>
        </div>
      </SiteChrome>
    </>
  );
}
