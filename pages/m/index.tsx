/**
 * File: pages/m/index.tsx
 * My Day — the SITE's day on a phone (PWA build step 3). A list, not a shrunk desktop grid:
 * time · reg · service · status, ordered by start. CACHE-FIRST: paints instantly from the
 * last-known day in IndexedDB, then revalidates — a quiet status line says "updated / offline",
 * never a blocking spinner. NO MONEY on this surface (v1). Identity + site resolve server-side
 * (/api/pwa/day); the switcher only selects among the sites the server returned.
 * Tapping a job opens the card read (build step 4).
 */
import { useCallback, useEffect, useState } from 'react';
import Head from 'next/head';
import { getServerSession } from 'next-auth';
import { useTranslation } from 'next-i18next';
import { authOptions } from '@/pages/api/auth/[...nextauth]';
import { withI18n } from '@/lib/gssp-i18n';
import { cacheGet, cachePut } from '@/lib/pwa-idb';

type DayJob = { id: string; startAt: string; endAt: string; reg: string; service: string; status: string; isComeback: boolean };
type DayData = { siteId: string | null; sites: Array<{ id: string; name: string }>; date: string | null; jobs: DayJob[] };

const STATUS_TONES: Record<string, string> = {
  in_progress: 'bg-warn-soft text-warn border-warn',
  done: 'bg-ok-soft text-ok border-ok',
  paid: 'bg-ok-soft text-ok border-ok',
  invoiced: 'bg-accent-soft text-accent border-accent',
  declined: 'bg-danger-soft text-danger border-danger',
  cancelled: 'bg-danger-soft text-danger border-danger',
};

export default function MyDay() {
  const { t } = useTranslation('pwa');
  const [data, setData] = useState<DayData | null>(null);
  const [net, setNet] = useState<'loading' | 'fresh' | 'offline'>('loading');
  const [site, setSite] = useState<string | null>(null);

  const load = useCallback(async (siteOverride?: string | null) => {
    const chosen = siteOverride !== undefined ? siteOverride : site;
    try {
      const res = await fetch(`/api/pwa/day${chosen ? `?site=${encodeURIComponent(chosen)}` : ''}`, { cache: 'no-store' });
      if (!res.ok) throw new Error(String(res.status));
      const fresh = (await res.json()) as DayData;
      setData(fresh);
      setNet('fresh');
      cachePut('day', fresh); // last-known state for the next cold open
      if (fresh.siteId) try { localStorage.setItem('gd-m-site', fresh.siteId); } catch { /* pref only */ }
    } catch {
      setNet('offline'); // keep whatever is rendered — never a blocking state
    }
  }, [site]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      // 1) paint from last-known immediately; 2) revalidate.
      const cached = await cacheGet<DayData>('day');
      if (cached && !cancelled) setData(cached.value);
      let pref: string | null = null;
      try { pref = localStorage.getItem('gd-m-site'); } catch { /* cold */ }
      if (!cancelled) { setSite(pref); await load(pref); }
    })();
    const onWake = () => load();
    window.addEventListener('online', onWake);
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') onWake(); });
    return () => { cancelled = true; window.removeEventListener('online', onWake); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const hhmm = (iso: string) => new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/London' });
  const chipTone = (s: string) => STATUS_TONES[s] ?? 'bg-surface-muted text-muted border-line';

  return (
    <>
      <Head>
        <title>{t('title')} - GreaseDesk</title>
        <link rel="manifest" href="/manifest.webmanifest" />
        <meta name="theme-color" content="#0B1E3B" />
        <meta name="apple-mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
        <meta name="apple-mobile-web-app-title" content="GreaseDesk" />
        <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
      </Head>
      <div className="min-h-screen" style={{ background: 'var(--content-bg)' }}>
        <header className="px-4 py-3" style={{ background: '#0B1E3B', color: '#FFFFFF', paddingTop: 'max(0.75rem, env(safe-area-inset-top))' }}>
          <div className="flex items-center justify-between gap-3">
            <div>
              <h1 className="text-base font-bold">{t('title')}</h1>
              {/* Quiet freshness line — informative, never blocking. */}
              <p className="text-xs" style={{ color: '#C7D2E1' }}>
                {net === 'offline' ? t('offline') : net === 'fresh' ? t('updated') : t('updating')}
              </p>
            </div>
            {(data?.sites?.length ?? 0) > 1 && (
              <select
                value={data?.siteId ?? ''}
                onChange={(e) => { setSite(e.target.value); load(e.target.value); }}
                aria-label={t('siteLabel')}
                className="min-h-[44px] rounded-lg px-2 text-sm"
                style={{ background: '#1C3257', color: '#FFFFFF', border: '1px solid #1C3257' }}
              >
                {data!.sites.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            )}
          </div>
        </header>

        <main className="p-3">
          {data == null ? (
            <p className="text-sm text-muted p-2">{t('updating')}</p>
          ) : data.jobs.length === 0 ? (
            <p className="text-sm text-muted p-2">{t('noJobs')}</p>
          ) : (
            <ul className="space-y-2">
              {data.jobs.map((j) => (
                /* Row becomes the card link in build step 4 — list-only for now. */
                <li key={j.id} className="bg-surface border border-line rounded-xl px-3 py-3 min-h-[56px] flex items-center gap-3">
                  <span className="text-sm font-semibold text-ink tabular-nums w-12 shrink-0">{hhmm(j.startAt)}</span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-bold text-ink">{j.reg}</span>
                    {j.service && <span className="block text-xs text-muted truncate">{j.service}</span>}
                  </span>
                  <span className={`shrink-0 text-[11px] font-semibold rounded-full border px-2 py-1 ${chipTone(j.status)}`}>
                    {t(`status.${j.status}`)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </main>
      </div>
    </>
  );
}

export const getServerSideProps = withI18n(['pwa'])(async (ctx) => {
  const session = await getServerSession(ctx.req, ctx.res, authOptions);
  const user = session?.user as any;
  if (!user?.id || !user?.group_id) return { redirect: { destination: '/admin/login?callbackUrl=%2Fm', permanent: false } }; // return HERE after auth, never the admin landing
  return { props: {} };
});
