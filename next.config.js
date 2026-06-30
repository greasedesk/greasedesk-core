/**
 * File: next.config.js
 */
const { i18n } = require('./next-i18next.config');

const nextConfig = {
  reactStrictMode: true,
  i18n, // locale routing (en-GB only for now) — see next-i18next.config.js
};

module.exports = nextConfig;
