/**
 * File: pages/_app.tsx
 * Last edited: 2025-10-27 21:25 Europe/London
 */
import type { AppProps } from "next/app";
import "../styles/globals.css";

export default function MyApp({ Component, pageProps }: AppProps) {
  return <Component {...pageProps} />;
}
