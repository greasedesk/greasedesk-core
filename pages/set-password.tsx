/**
 * File: pages/set-password.tsx
 * Public invite landing. Validates the token (SSR), lets a valid/unexpired/unused invite set a
 * password, then AUTO-SIGNS-IN with the new password and lands on the profile-completion page.
 * Invalid / expired / used tokens show a clear message and no form.
 */
import React, { useState } from 'react';
import Head from 'next/head';
import SiteChrome from '@/components/marketing/SiteChrome';
import Link from 'next/link';
import { GetServerSideProps } from 'next';
import { signIn } from 'next-auth/react';
import { prisma } from '@/lib/db';
import { hashToken } from '@/lib/tokens';

type State = 'valid' | 'invalid' | 'expired' | 'used';
type PageProps = { state: State; email: string | null; token: string | null };

const MESSAGES: Record<Exclude<State, 'valid'>, string> = {
  invalid: 'This invite link is invalid. Please ask your admin for a new invite.',
  expired: 'This invite link has expired. Please ask your admin to resend it.',
  used: 'This invite has already been used. You can sign in with your password.',
};

export default function SetPasswordPage({ state, email, token }: PageProps) {
  const [pw, setPw] = useState('');
  const [cf, setCf] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch('/api/auth/set-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, newPassword: pw, confirmPassword: cf }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { setErr(data?.message || 'Could not set your password.'); setBusy(false); return; }
      // END-TO-END handoff: sign in with the email (from the validated token) + the new password,
      // then land on Settings, which role-routes the user to their own account detail.
      await signIn('credentials', { email: data.email || email, password: pw, callbackUrl: '/admin/settings' });
      // signIn redirects on success; if it returns, surface a fallback.
      setBusy(false);
    } catch {
      setErr('Network error. Please try again.');
      setBusy(false);
    }
  }

  return (
    <>
      <Head><title>Set your password - GreaseDesk</title></Head>
      <SiteChrome>
      <div className="max-w-md mx-auto px-4 sm:px-6 pt-10 sm:pt-14 pb-16">
        <div className="bg-surface border border-line rounded-2xl shadow-card p-8">
          <h1 className="text-xl font-semibold text-ink mb-6 text-center">Set your password</h1>

          {state !== 'valid' ? (
            <div className="text-center">
              <div className="bg-warn-soft/40 border border-warn text-warn rounded-lg p-3 text-sm mb-4">
                {MESSAGES[state]}
              </div>
              <Link href="/admin/login" className="text-accent hover:underline text-sm">Go to sign in</Link>
            </div>
          ) : (
            <form onSubmit={submit} className="space-y-4">
              <p className="text-sm text-muted">Welcome{email ? ` (${email})` : ''} — choose a password to activate your account.</p>
              {err && <div className="bg-danger-soft text-danger rounded-lg p-3 text-sm">{err}</div>}
              <div>
                <label className="block text-sm text-muted mb-1">New password (min 8 characters)</label>
                <input type="password" value={pw} onChange={(e) => setPw(e.target.value)} required className="w-full p-3 bg-surface border border-line rounded-lg text-ink focus:ring-2 focus:ring-accent" />
              </div>
              <div>
                <label className="block text-sm text-muted mb-1">Confirm password</label>
                <input type="password" value={cf} onChange={(e) => setCf(e.target.value)} required className="w-full p-3 bg-surface border border-line rounded-lg text-ink focus:ring-2 focus:ring-accent" />
              </div>
              <button type="submit" disabled={busy} className="w-full bg-accent hover:bg-accent-hover text-white font-semibold rounded-xl px-4 py-2.5 disabled:opacity-50">
                {busy ? 'Setting up…' : 'Set password & continue'}
              </button>
            </form>
          )}
        </div>
      </div>
      </SiteChrome>
    </>
  );
}

export const getServerSideProps: GetServerSideProps<PageProps> = async (ctx) => {
  const token = (ctx.query.token as string) || '';
  if (!token) return { props: { state: 'invalid', email: null, token: null } };

  const user = await prisma.user.findFirst({
    where: { invite_token_hash: hashToken(token) },
    select: { email: true, invite_token_expires: true, invite_token_used_at: true },
  });

  if (!user) return { props: { state: 'invalid', email: null, token: null } };
  if (user.invite_token_used_at) return { props: { state: 'used', email: user.email, token: null } };
  if (!user.invite_token_expires || new Date() > new Date(user.invite_token_expires)) {
    return { props: { state: 'expired', email: user.email, token: null } };
  }
  return { props: { state: 'valid', email: user.email, token } };
};
