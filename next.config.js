/**
 * File: next.config.js
 */
const { i18n } = require('./next-i18next.config');

const nextConfig = {
  reactStrictMode: true,
  i18n, // locale routing (en-GB only for now) — see next-i18next.config.js
  // next-i18next reads locale JSON at runtime from a path built via process.cwd() — which the
  // file-tracer can't see, so on Vercel the files are missing from the serverless function and
  // every t() falls back to the raw key. Force-trace public/locales/** into every function.
  // (Next 14.2: lives under `experimental`; moves top-level in Next 15.)
  experimental: {
    outputFileTracingIncludes: {
      '/**': ['./public/locales/**'],
    },
  },
};

module.exports = nextConfig;
