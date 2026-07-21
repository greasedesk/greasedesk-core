/**
 * File: pages/_app.tsx
 * App wrapper. Wires next-i18next (appWithTranslation) and loads the 'common' namespace
 * APP-WIDE via getInitialProps so the shell (AdminLayout) is translated on every page without
 * each page calling serverSideTranslations. Pages needing EXTRA namespaces use lib/gssp-i18n.
 * Also keeps the global safe Response.json() patch.
 */
import App, { AppContext, AppProps } from 'next/app';
import { useEffect } from 'react';
import '@/styles/globals.css';
import { SessionProvider } from 'next-auth/react';
import { appWithTranslation } from 'next-i18next';
import AdminLayout from '@/components/layout/AdminLayout';
import { ConsentProvider, useConsent } from '@/components/consent/ConsentProvider';
import ConsentBanner from '@/components/consent/ConsentBanner';
import { parseConsentCookie, sanitiseRef, type ConsentRecord } from '@/lib/consent';
import { resolveConsentRegion } from '@/lib/consent-config';
// NOTE: serverSideTranslations (server-only, uses `fs`) is dynamically imported inside the
// server branch of getInitialProps below — importing it at top level would pull `fs` into the
// client bundle (_app ships to the client).
// @ts-ignore — JS config (no type declarations); shape is the next-i18next UserConfig.
import nextI18NextConfig from '../next-i18next.config';

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

// PERSISTENT admin shell: AdminLayout (dark rail + locations bar) is mounted ONCE here for every
// /admin route (except the login page) instead of inside each page. Across admin navigations React
// keeps the same AdminLayout instance mounted — it never remounts, so the locations bar doesn't
// refetch/flicker and tab switches don't do a full-shell teardown (fast INP, no layout shift).
// Login renders bare; the settings redirect shims return null and redirect server-side (harmless).
// REFERRAL CAPTURE — now CONSENT-GATED. A public ?ref= is routed through the consent manager, which
// writes gd_ref only if functional consent is (or becomes) granted; refuse → no attribution cookie.
// Runs inside ConsentProvider so it can read the choice.
function RefCapture({ refValue, ready }: { refValue: unknown; ready: boolean }) {
  const { noteRef } = useConsent();
  useEffect(() => {
    if (!ready) return;
    const clean = sanitiseRef(refValue);
    if (clean) noteRef(clean);
  }, [ready, refValue, noteRef]);
  return null;
}

function GreaseDeskApp({ Component, pageProps, router }: AppProps) {
  const useAdminShell = router.pathname.startsWith('/admin') && router.pathname !== '/admin/login';
  // The consent banner shows ONLY on the public marketing site — never a wall in front of the tenant app
  // or the Engine Room login (those run strictly-necessary session cookies only). Excludes /admin, /m,
  // and /superadmin (the last covers er.greasedesk.com, whose routes are all /superadmin/*).
  const isAppRoute = router.pathname.startsWith('/admin') || router.pathname.startsWith('/m') || router.pathname.startsWith('/superadmin');
  const initialConsent = ((pageProps as any).__consent ?? null) as ConsentRecord | null;
  const region = ((pageProps as any).__consentRegion ?? 'GB') as string;
  const page = <Component {...pageProps} />;
  return (
    <SessionProvider session={pageProps.session}>
      <ConsentProvider initialRecord={initialConsent} region={region}>
        <RefCapture refValue={router.query.ref} ready={router.isReady} />
        {useAdminShell ? <AdminLayout>{page}</AdminLayout> : page}
        {!isAppRoute && <ConsentBanner />}
      </ConsentProvider>
    </SessionProvider>
  );
}

const GreaseDeskAppWithI18n = appWithTranslation(GreaseDeskApp, nextI18NextConfig);

// Load 'common' for every page on the server. On client navigations i18next already has it cached,
// so we skip the (server-only) filesystem read. (This opts the app out of Automatic Static
// Optimization — irrelevant here: every page already uses getServerSideProps.)
// Attached to the WRAPPED component so Next reliably finds getInitialProps on the default export.
(GreaseDeskAppWithI18n as any).getInitialProps = async (appCtx: AppContext) => {
  const appProps = await App.getInitialProps(appCtx);
  if (typeof window === 'undefined') {
    const { serverSideTranslations } = await import('next-i18next/serverSideTranslations');
    const locale = appCtx.ctx.locale || nextI18NextConfig.i18n.defaultLocale;
    const i18nProps = await serverSideTranslations(locale, ['common'], nextI18NextConfig as any);
    // Seed consent from the request cookie so the banner never flashes for a returning visitor, and
    // resolve the region for its copy/defaults (GB today; /ie → IE when that region ships).
    const __consent = parseConsentCookie(appCtx.ctx.req?.headers?.cookie);
    const __consentRegion = resolveConsentRegion(appCtx.ctx.asPath || appCtx.router?.asPath);
    return { ...appProps, pageProps: { ...appProps.pageProps, ...i18nProps, __consent, __consentRegion } };
  }
  return appProps;
};

export default GreaseDeskAppWithI18n;
