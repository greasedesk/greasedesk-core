/**
 * File: pages/_app.tsx
 * Last edited: 2025-11-13 18:38 Europe/London (FIXED - ADDED SESSION PROVIDER)
 *
 * App wrapper + global safe Response.json() patch to prevent crashes
 * if any fetch tries to parse empty/non-JSON bodies.
 * 
 * xxx
 */
import type { AppProps } from 'next/app';
import '@/styles/globals.css';
// 💥 FIX: Import the SessionProvider
import { SessionProvider } from 'next-auth/react'; 

declare global {
  interface Window { __gd_json_patched?: boolean }
}

if (typeof window !== 'undefined' && !window.__gd_json_patched) {
  window.__gd_json_patched = true;
  const original = Response.prototype.json;
  Response.prototype.json = async function safeJson(this: Response) {
    try {
      const clone = this.clone();
      const text = await clone.text();
      if (!text) return {};              // empty body → harmless object
      try { return JSON.parse(text); }    // valid JSON by content
      catch { return await original.call(this.clone()); } // fallback to original
    } catch {
      try { return await original.call(this.clone()); }
      catch { return {}; }
    }
  };
}

export default function App({ Component, pageProps }: AppProps) {
  // 💥 FIX: Wrap the application in <SessionProvider>
  return (
    <SessionProvider session={pageProps.session}>
      <Component {...pageProps} />
    </SessionProvider>
  );
}