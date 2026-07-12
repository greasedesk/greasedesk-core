/**
 * File: pages/m/index.tsx
 * The phone surface's shell (PWA build step 1): installable scope root. The manifest is linked
 * HERE and only here — the mechanic app installs; the desktop admin never offers to. Session-gated
 * like every surface; site/role resolve server-side in later steps (/api/pwa/*) — the phone never
 * tells the server who it is. My Day (step 3) replaces the placeholder body.
 */
import Head from 'next/head';
import { getServerSession } from 'next-auth';
import { useTranslation } from 'next-i18next';
import { authOptions } from '@/pages/api/auth/[...nextauth]';
import { withI18n } from '@/lib/gssp-i18n';

export default function MobileShell() {
  const { t } = useTranslation('pwa');
  return (
    <>
      <Head>
        <title>{t('title')} - GreaseDesk</title>
        {/* PWA manifest — /m scope ONLY (deliberate: see file header). */}
        <link rel="manifest" href="/manifest.webmanifest" />
        {/* Paints the Android status bar in standalone — the brand rail navy, same as the header below. */}
        <meta name="theme-color" content="#0B1E3B" />
        <meta name="apple-mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
        <meta name="apple-mobile-web-app-title" content="GreaseDesk" />
        <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
      </Head>
      <div className="min-h-screen" style={{ background: 'var(--content-bg)' }}>
        <header className="px-4 py-3" style={{ background: '#0B1E3B', color: '#FFFFFF', paddingTop: 'max(0.75rem, env(safe-area-inset-top))' }}>
          <h1 className="text-base font-bold">GreaseDesk</h1>
          <p className="text-xs" style={{ color: '#C7D2E1' }}>{t('subtitle')}</p>
        </header>
        <main className="p-4">
          <p className="text-sm text-muted">{t('shellPlaceholder')}</p>
        </main>
      </div>
    </>
  );
}

export const getServerSideProps = withI18n(['pwa'])(async (ctx) => {
  const session = await getServerSession(ctx.req, ctx.res, authOptions);
  const user = session?.user as any;
  if (!user?.id || !user?.group_id) return { redirect: { destination: '/admin/login', permanent: false } };
  return { props: {} };
});
