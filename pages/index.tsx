/**
 * File: pages/index.tsx
 * Last edited: 2025-10-27 21:25 Europe/London
 *
 * Landing page placeholder.
 * Eventually this becomes dashboard after login.
 */
import Link from "next/link";

export default function HomePage() {
  return (
    <main className="min-h-screen bg-slate-900 text-slate-100 flex items-center justify-center p-6">
      <div className="max-w-md w-full bg-gdPanel/80 border border-gdBorder rounded-2xl shadow-card p-8 text-center">
        <h1 className="text-xl font-semibold text-gdText mb-2">
          GreaseDesk Core
        </h1>
        <p className="text-gdSubtext text-sm mb-6">
          Multi-tenant garage platform for bookings, job cards and intake
          photos. This is a pre-launch build.
        </p>
        <Link
          href="/login"
          className="inline-block bg-gdAccent text-slate-900 font-medium rounded-xl px-4 py-2"
        >
          Sign in
        </Link>
      </div>
    </main>
  );
}
