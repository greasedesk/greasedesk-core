/**
 * File: next-i18next.config.js
 * i18n config — ONE locale for now (en-GB). Adding a language later = add its code to `locales`
 * here, drop a public/locales/<code>/common.json file, and add a COUNTRY_PROFILES entry. No rebuild.
 */
module.exports = {
  i18n: {
    defaultLocale: 'en-GB',
    locales: ['en-GB'],
  },
  // Reload translations on each request in dev so edits to JSON show without a restart.
  reloadOnPrerender: process.env.NODE_ENV === 'development',
};
