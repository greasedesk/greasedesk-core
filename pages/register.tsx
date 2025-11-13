/**
 * File: pages/register.tsx
 * Last edited: 2025-11-12 21:06 Europe/London
 *
 * SaaS Onboarding Step 1: Account Creation (for Garage Owner)
 * On success, redirects to /onboarding/check-email
 *
 * Hardening:
 *  - Dev-only patch of Response.prototype.json so empty/non-JSON bodies never crash.
 *  - Fetch reads text, then safely parses JSON; shows API "where" marker on error.
 *  - Sends Accept: application/json and disables caches to avoid stale intermediaries.
 */

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/router';
import Head from 'next/head';

/* ─────────────────────  SAFE JSON PATCH (browser + dev only)  ───────────────────── */

declare global {
  interface Window { __gd_json_patched?: boolean }
}

if (
  typeof window !== 'undefined' &&
  process.env.NODE_ENV !== 'production' &&
  !window.__gd_json_patched &&
  typeof Response !== 'undefined'
) {
  try {
    const origJson = Response.prototype.json;
    Response.prototype.json = async function patchedJson(this: Response): Promise<any> {
      try {
        const txt = await this.clone().text();
        if (!txt) return {};
        try { return JSON.parse(txt); } catch { return await origJson.call(this.clone()); }
      } catch {
        try { return await origJson.call(this.clone()); } catch { return {}; }
      }
    };
    window.__gd_json_patched = true;
  } catch {
    // noop — don’t let any patching error affect the page
  }
}

/* ──────────────────────────────────────────────────────────────────────────────── */

export default function RegisterPage() {
  const router = useRouter();

  // Form state
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');

  // UI state
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [debug, setDebug] = useState<string | null>(null); // dev-only helper

  function isValidEmail(v: string) {
    return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v);
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (loading) return; // double-submit guard
    setLoading(true);
    setError(null);
    setDebug(null);

    const nameTrim = name.trim();
    const emailNorm = email.trim().toLowerCase();
    const pass = password;

    if (!nameTrim || !emailNorm || !pass) {
      setError('Please fill in all fields.');
      setLoading(false);
      return;
    }
    if (!isValidEmail(emailNorm)) {
      setError('Please enter a valid email address.');
      setLoading(false);
      return;
    }
    if (pass.length < 8) {
      setError('Password must be at least 8 characters long.');
      setLoading(false);
      return;
    }

    const url = '/api/auth/register-garage';

    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          'Cache-Control': 'no-store',
          'Pragma': 'no-cache',
        },
        body: JSON.stringify({ name: nameTrim, email: emailNorm, password: pass }),
      });

      const status = res.status;
      const statusText = res.statusText || '';
      const contentType = res.headers.get('content-type') || '';
      const raw = await res.text();

      let payload: any = null;
      // We still try JSON regardless of header because some servers forget to set it.
      try { payload = raw ? JSON.parse(raw) : null; } catch { payload = null; }

      if (process.env.NODE_ENV !== 'production' && (!res.ok || !payload?.ok)) {
        setDebug(
          `url=${url}\nstatus=${status} ${statusText}\ncontent-type="${contentType}"\nraw=${raw || '<empty>'}`
        );
        // Also echo in DevTools:
        console.debug('register-garage response:', { url, status, statusText, contentType, raw, payload });
      }

      const okFlag = payload?.ok ?? res.ok;
      const where = payload?.where ? ` [${payload.where}]` : '';
      const msg =
        (payload && (payload.message || payload.error)) ||
        raw ||
        (res.ok ? 'Success' : `Registration failed (HTTP ${status}).`);

      if (!okFlag) {
        throw new Error(`${msg}${where}`);
      }

      // Success: redirect to "Check Your Email"
      router.push(`/onboarding/check-email?email=${encodeURIComponent(emailNorm)}`);
    } catch (err: any) {
      setError(err?.message || 'Registration failed. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <>
      <Head>
        <title>Start Your Free Trial - GreaseDesk</title>
      </Head>
      <main className="min-h-screen bg-slate-900 text-slate-100 flex items-center justify-center p-6">
        <div className="max-w-md w-full bg-gdPanel/80 border border-gdBorder rounded-2xl shadow-card p-8">
          <h1 className="text-xl font-semibold text-gdText mb-6 text-center">
            Start Your Free Trial
          </h1>

        {/* Error Message */}
        {error && (
          <div className="bg-red-800 border border-red-600 text-red-200 p-3 rounded-lg text-center mb-4">
            <p className="font-semibold">Registration Failed</p>
            <p className="text-sm">{error}</p>
            {process.env.NODE_ENV !== 'production' && debug && (
              <pre className="mt-2 text-[11px] text-red-100/80 whitespace-pre-wrap break-all opacity-80">
{debug}
              </pre>
            )}
          </div>
        )}

        {/* Signup Form */}
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gdSubtext mb-1">Full Name</label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              autoComplete="name"
              className="w-full bg-slate-800 border border-gdBorder rounded-lg px-3 py-2 text-gdText focus:outline-none focus:ring-2 focus:ring-gdAccent"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gdSubtext mb-1">Email Address</label>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              autoComplete="email"
              className="w-full bg-slate-800 border border-gdBorder rounded-lg px-3 py-2 text-gdText focus:outline-none focus:ring-2 focus:ring-gdAccent"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gdSubtext mb-1">Password (min. 8 characters)</label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              autoComplete="new-password"
              className="w-full bg-slate-800 border border-gdBorder rounded-lg px-3 py-2 text-gdText focus:outline-none focus:ring-2 focus:ring-gdAccent"
            />
          </div>

          <button
            type="submit"
            disabled={loading}
            className="w-full bg-gdAccent text-slate-900 font-medium rounded-xl px-4 py-2 disabled:opacity-50"
          >
            {loading ? 'Creating Account...' : 'Create Account'}
          </button>
        </form>

        <div className="text-center mt-6">
          <Link href="/admin/login" className="text-sm text-gdSubtext hover:text-gdAccent">
            Already have an account? Sign In
          </Link>
        </div>
        </div>
      </main>
    </>
  );
}
