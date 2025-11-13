/**
 * File: pages/onboarding/verify-status.tsx
 * Last edited: 2025-11-13 at 17:28 Europe/London
 *
 * Client-side page to display user-friendly error messages
 * after a failed email verification attempt (via /api/auth/verify).
 */

import { useRouter } from 'next/router';
import Head from 'next/head';
import Link from 'next/link';

// Component to handle the various status messages
const StatusMessage: React.FC<{ status: string | undefined }> = ({ status }) => {
  const commonStyles = "text-center p-8 rounded-xl max-w-lg mx-auto shadow-2xl";

  switch (status) {
    case 'used':
      return (
        <div className={`${commonStyles} bg-yellow-800/80 border-yellow-600`}>
          <h1 className="text-3xl font-bold mb-3 text-yellow-200">Link Already Used</h1>
          <p className="text-lg text-yellow-100 mb-6">
            It looks like this verification link has already been used to activate your account.
            Please proceed to the sign-in page to log in.
          </p>
          <Link href="/admin/login" className="text-yellow-200 underline font-semibold hover:text-yellow-100 transition">
            Go to Sign In
          </Link>
        </div>
      );
    case 'expired':
      return (
        <div className={`${commonStyles} bg-red-800/80 border-red-600`}>
          <h1 className="text-3xl font-bold mb-3 text-red-200">Link Expired</h1>
          <p className="text-lg text-red-100 mb-6">
            This verification link is over 24 hours old and has expired.
            Please register again to receive a fresh verification email.
          </p>
          <Link href="/register" className="text-red-200 underline font-semibold hover:text-red-100 transition">
            Register Again
          </Link>
        </div>
      );
    case 'invalid':
    case 'server':
      return (
        <div className={`${commonStyles} bg-red-900/80 border-red-700`}>
          <h1 className="text-3xl font-bold mb-3 text-red-300">Verification Failed</h1>
          <p className="text-lg text-red-100 mb-6">
            We encountered an issue with your verification link. It may be incomplete or invalid.
            If the problem persists, please register again.
          </p>
          <Link href="/register" className="text-red-300 underline font-semibold hover:text-red-100 transition">
            Register Again
          </Link>
        </div>
      );
    default:
      return (
        <div className={`${commonStyles} bg-slate-700/80 border-slate-600`}>
          <h1 className="text-3xl font-bold mb-3 text-white">Verification Status</h1>
          <p className="text-lg text-slate-300">
            Checking status...
          </p>
        </div>
      );
  }
};


export default function VerifyStatusPage() {
  const router = useRouter();
  const { error } = router.query;
  const status = typeof error === 'string' ? error : undefined;

  return (
    <>
      <Head>
        <title>Verification Status - GreaseDesk</title>
      </Head>
      <main className="min-h-screen bg-slate-900 text-white flex items-center justify-center p-6">
        <StatusMessage status={status} />
      </main>
    </>
  );
}