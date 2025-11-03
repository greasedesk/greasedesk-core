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
      callbackUrl: context.query.callbackUrl || '/admin/bookings',
    },
  };
}

export default function AdminLoginPage({ csrfToken, error, email, status, callbackUrl }: { csrfToken: string, error: string | null, email: string | null, status: string | null, callbackUrl: string }) {
  const [loginEmail, setLoginEmail] = useState(email || '');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const router = useRouter();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);

    // Call NextAuth signin provider
    const result = await signIn('credentials', {
      redirect: false,
      email: loginEmail,
      password: password,
      callbackUrl: callbackUrl, // Use the destination we passed
    });

    setLoading(false);

    if (result && result.error) {
      router.push(`/admin/login?error=InvalidCredentials`);
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
    return null;
  };

  return (
    <>
      <Head>
        <title>Staff Sign In - GreaseDesk</title>
      </Head>
      <main className="min-h-screen bg-slate-900 text-slate-100 flex items-center justify-center p-6">
        <div className="max-w-md w-full bg-gdPanel/80 border border-gdBorder rounded-2xl shadow-card p-8">
          
          <h1 className="text-xl font-semibold text-gdText mb-6 text-center">
            Staff Sign In
          </h1>

          <p className="text-sm text-slate-400 text-center mb-6">
            Sign in to manage your job cards and garage operations.
          </p>

          {/* Error/Status Message Display */}
          {getErrorMessage() && (
            <div className={`p-3 rounded-lg text-center mb-4 ${status === 'verified' ? 'bg-green-800 text-green-200' : 'bg-red-800 text-red-200'}`}>
              <p className="text-sm">{getErrorMessage()}</p>
            </div>
          )}

          <form onSubmit={handleSubmit} className="space-y-4">
            <input name="csrfToken" type="hidden" defaultValue={csrfToken} /> 
            
            <div>
              <label className="block text-sm font-medium text-gdSubtext mb-1">Email Address</label>
              <input
                type="email"
                value={loginEmail}
                onChange={(e) => setLoginEmail(e.target.value)}
                required
                className="w-full bg-slate-800 border border-gdBorder rounded-lg px-3 py-2 text-gdText focus:outline-none focus:ring-2 focus:ring-gdAccent"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gdSubtext mb-1">Password</label>
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
              className="w-full bg-gdAccent text-slate-900 font-medium rounded-xl px-4 py-2 disabled:opacity-50 flex items-center justify-center gap-2"
            >
              {loading && <LoadingSpinner />}
              {loading ? 'Signing In...' : 'Sign In'}
            </button>
          </form>

          <div className="text-center mt-6">
            <Link href="/register" className="text-sm text-gdSubtext hover:text-gdAccent">
              Don't have a garage account? Register here.
            </Link>
          </div>
        </div>
      </main>
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
