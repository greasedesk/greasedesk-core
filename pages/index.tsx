/**
 * File: pages/index.tsx
 * Last edited: 2025-11-02 at 18:05
 *...
 * A modern, graphically-friendly SaaS landing page
 * inspired by Sage, Xero, and Motasoft.
 */
import Link from 'next/link';
import Head from 'next/head';

// A simple checkmark icon component for the feature list
const CheckIcon = () => (
  <svg
    className="w-5 h-5 text-green-400"
    fill="none"
    stroke="currentColor"
    viewBox="0 0 24 24"
    xmlns="http://www.w3.org/2000/svg"
  >
    <path
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth={2}
      d="M5 13l4 4L19 7"
    />
  </svg>
);

export default function HomePage() {
  return (
    <>
      <Head>
        <title>GreaseDesk - All-In-One Garage Management Software</title>
        <meta
          name="description"
          content="The all-in-one garage management platform for job cards, bookings, and customer management. Start your free trial today."
        />
      </Head>

      {/* Main container with dark theme */}
      <div className="min-h-screen bg-slate-900 text-slate-100 font-sans">
        {/* Header/Navigation */}
        <header className="border-b border-gdBorder/50">
          <nav className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 flex justify-between items-center h-20">
            {/* Logo */}
            <div className="text-2xl font-bold text-white">
              GreaseDesk
            </div>
            
            {/* Nav Links & Buttons */}
            <div className="flex items-center space-x-6">
              <Link href="/features" className="text-sm font-medium text-slate-300 hover:text-white transition-colors">
                Features
              </Link>
              <Link href="/pricing" className="text-sm font-medium text-slate-300 hover:text-white transition-colors">
                Pricing
              </Link>
              <span className="w-px h-6 bg-gdBorder/50" aria-hidden="true" />
              <Link
                href="/admin/login" // This is the single "Sign In" for ALL existing users
                className="text-sm font-medium text-slate-300 hover:text-white transition-colors"
              >
                Sign In
              </Link>
              <Link
                href="/register" // This is the new Garage Owner signup
                className="inline-block bg-gdAccent text-slate-900 font-medium rounded-lg px-5 py-2.5 text-sm hover:bg-blue-400 transition-colors"
              >
                Start Free Trial
              </Link>
            </div>
          </nav>
        </header>

        {/* Hero Section */}
        <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="text-center py-24 sm:py-32">
            <h1 className="text-4xl sm:text-6xl font-extrabold text-white tracking-tight">
              All-in-one
              <span className="text-gdAccent"> Garage Management</span>
              <br />
              Software.
            </h1>
            <p className="mt-6 text-lg text-slate-300 max-w-2xl mx-auto">
              Manage your job cards, bookings, and customer communication from one simple, powerful platform. 
              Built for modern workshops.
            </p>
            <div className="mt-10 flex flex-col sm:flex-row gap-4 justify-center">
              <Link
                href="/register" // This links to the new garage registration
                className="inline-block bg-gdAccent text-slate-900 font-semibold rounded-lg px-6 py-3.5 text-base shadow-lg hover:bg-blue-400 transition-colors"
              >
                Start Your 60-Day Free Trial
              </Link>
              <Link
                href="/book-a-demo" // A demo link, like Motasoft/TechMan
                className="inline-block bg-gdBorder text-gdText font-medium rounded-lg px-6 py-3.5 text-base hover:bg-slate-700 transition-colors"
              >
                Book a Demo
              </Link>
            </div>
            <p className="mt-4 text-sm text-slate-400">
               Payment card required. Cancel anytime.
            </p>
          </div>

          {/* Features Section (Placeholder) */}
          <div className="pb-24 sm:pb-32">
            <div className="grid grid-cols-1 md:grid-cols-3 gap-8">
              {/* Feature 1 */}
              <div className="bg-gdPanel/80 border border-gdBorder rounded-2xl p-6">
                <CheckIcon />
                <h3 className="mt-4 text-lg font-semibold text-white">Digital Job Cards</h3>
                <p className="mt-2 text-sm text-slate-400">
                  Ditch the paper. Create, update, and manage all your jobs digitally with photo uploads.
                </p>
              </div>
              {/* Feature 2 */}
              <div className="bg-gdPanel/80 border border-gdBorder rounded-2xl p-6">
                <CheckIcon />
                <h3 className="mt-4 text-lg font-semibold text-white">Online Bookings</h3>
                <p className="mt-2 text-sm text-slate-400">
                  Integrate a live booking calendar into your website (coming in a future module).
                </p>
              </div>
              {/* Feature 3 */}
              <div className="bg-gdPanel/80 border border-gdBorder rounded-2xl p-6">
                <CheckIcon />
                <h3 className="mt-4 text-lg font-semibold text-white">Multi-Site Ready</h3>
                <p className="mt-2 text-sm text-slate-400"> Built from the ground up to support multiple sites and profit centres from one login.
                </p>
              </div>
            </div>
          </div>
        </main>
      </div>
    </>
  );
}