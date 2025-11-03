/**
 * File: pages/_app.tsx
 * Last edited: 2025-11-02 at 14:25
 */
import type { AppProps } from "next/app";
import { SessionProvider } from "next-auth/react";
import "../styles/globals.css";

// The fix is on the line below:
// We destructure 'session' out of pageProps, and pass the rest of pageProps on.
export default function MyApp({ Component, pageProps: { session, ...pageProps } }: AppProps) {
  return (
    <SessionProvider session={session}>
      <Component {...pageProps} />
    </SessionProvider>
  );
}
