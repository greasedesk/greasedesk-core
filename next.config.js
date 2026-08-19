/**
 * File: next.config.js
 */
const { i18n } = require('./next-i18next.config');

const nextConfig = {
  reactStrictMode: true,
  i18n, // locale routing (en-GB only for now) — see next-i18next.config.js
  // Dead pre-NextAuth routes deleted 2026-07-12 — bookmark-safe redirects to the real surfaces.
  // Next preserves the query string by default, so /login?callbackUrl=… carries through.
  async redirects() {
    return [
      { source: '/login', destination: '/admin/login', permanent: false },
      { source: '/bookings', destination: '/admin/diary', permanent: false },
      { source: '/jobcard/:id', destination: '/admin/jobcards/:id', permanent: false },
    ];
  },
  // next-i18next reads locale JSON at runtime from a path built via process.cwd() — which the
  // file-tracer can't see, so on Vercel the files are missing from the serverless function and
  // every t() falls back to the raw key. Force-trace public/locales/** into every function.
  // (Next 14.2: lives under `experimental`; moves top-level in Next 15.)
  experimental: {
    outputFileTracingIncludes: {
      '/**': ['./public/locales/**'],
    },
  },
  // lib/db is reachable from a page's import graph (pages/c/[token] → lib/magic-link → lib/db), so
  // webpack tries to resolve its imports for the BROWSER bundle as well as the server one. The
  // dev-only staleness guard in lib/client-freshness reads a file, and `fs` has no browser
  // equivalent, so the client build failed to resolve it and every page 500'd.
  //
  // `false` means "resolve this to an empty module in the client bundle" — the standard answer, and
  // safe here because nothing in that file is ever CALLED in a browser: clientIsStale runs only
  // inside the Prisma query extension, which is server-side by construction. If a browser path ever
  // does reach it, the failure is a clear "readFileSync is not a function", not a silent wrong
  // answer — see the null-means-cannot-tell rule in lib/client-freshness.
  webpack: (config, { isServer }) => {
    if (!isServer) {
      config.resolve.fallback = { ...config.resolve.fallback, fs: false, path: false, crypto: false };
    }
    return config;
  },
};

module.exports = nextConfig;
