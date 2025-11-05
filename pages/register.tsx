/**
 * File: pages/register.tsx
 * Last edited: 2025-11-02 at 19:55
 *
 * SaaS Onboarding Step 1: Account Creation (for Garage Owner)
 * On success, now redirects to /onboarding/check-email
 */
import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/router';
import Head from 'next/head';

export default function RegisterPage() {
  const router = useRouter();

  
  // Form state
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');

  // UI state
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);

    if (password.length < 8) {
      setError('Password must be at least 8 characters long.');
      setLoading(false);
      return;
    }

    try {
      const res = await fetch('/api/auth/register-garage', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ name, email, password }),
      });

      const data = await res.json();

      if (!res.ok) {
        throw new Error(data.message || 'Something went wrong.');
      }

      // Success! Redirect to the "Check Your Email" page,
      // passing the email along in the query to display it.
      router.push(`/onboarding/check-email?email=${encodeURIComponent(email)}`);

    } catch (err: any) {
      setError(err.message);
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

          {/* --- Error Message --- */}
          {error && (
            <div className="bg-red-800 border border-red-600 text-red-200 p-3 rounded-lg text-center mb-4">
              <p className="font-semibold">Registration Failed</p>
              <p className="text-sm">{error}</p>
            </div>
          )}

          {/* --- Signup Form --- */}
          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-gdSubtext mb-1">Full Name</label>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
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