/**
 * File: pages/login.tsx
 * Last edited: 2025-10-27 21:25 Europe/London
 *
 * Fake login for now. We'll wire /api/login → JWT/session later.
 */
import { useState } from "react";
import { useRouter } from "next/router";

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("tech@theminispecialist.com");
  const [password, setPassword] = useState("");

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    
    // call placeholder API
    const res = await fetch("/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password })
    });

    if (res.ok) {
      // eventually we will store auth token etc.
      router.push("/bookings");
    } else {
      alert("Login failed (placeholder)");
    }
  }

  return (
    <main className="min-h-screen flex items-center justify-center bg-slate-900 p-6 text-slate-100">
      <div className="w-full max-w-sm bg-gdPanel/80 border border-gdBorder rounded-2xl shadow-card p-6">
        <h1 className="text-lg font-semibold text-gdText mb-1">
          Sign in to GreaseDesk
        </h1>
        <p className="text-gdSubtext text-sm mb-6">
          Use your workshop login to view today&apos;s jobs.
        </p>

        <form onSubmit={handleSubmit} className="space-y-4 text-left">
          <div>
            <label className="block text-xs font-medium text-gdSubtext mb-1">
              Email
            </label>
            <input
              className="w-full rounded-xl bg-slate-800 border border-gdBorder px-3 py-2 text-sm text-gdText outline-none focus:ring-2 focus:ring-gdAccent"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoComplete="email"
            />
          </div>

          <div>
            <label className="block text-xs font-medium text-gdSubtext mb-1">
              Password
            </label>
            <input
              className="w-full rounded-xl bg-slate-800 border border-gdBorder px-3 py-2 text-sm text-gdText outline-none focus:ring-2 focus:ring-gdAccent"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
            />
          </div>

          <button
            type="submit"
            className="w-full bg-gdAccent text-slate-900 font-semibold text-sm rounded-xl py-2"
          >
            Sign in
          </button>
        </form>
      </div>
    </main>
  );
}
