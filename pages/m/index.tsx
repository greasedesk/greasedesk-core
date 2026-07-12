/**
 * File: pages/m/index.tsx
 * The DIARY DAY, phone-shaped (not a second diary — /api/pwa/day reads the same lib/diary-day
 * chokepoint as the desktop gssp). Down the screen: day nav (← date → / Today) · day notes ·
 * "On the lift now" · the day's bookings in time order (colour bar by status, reg large,
 * customer, lift, service, chip) · reg search as the standing escape hatch. CACHE-FIRST per
 * date; quiet offline line; outbox strip; 56px touch targets. NO MONEY on this surface — the
 * server projects it out before it leaves the building.
 */
import { useCallback, useEffect, useState } from 'react';
import Head from 'next/head';
import Link from 'next/link';
import { getServerSession } from 'next-auth';
import { useTranslation } from 'next-i18next';
import { authOptions } from '@/pages/api/auth/[...nextauth]';
import { withI18n } from '@/lib/gssp-i18n';
import { cacheGet, cachePut } from '@/lib/pwa-idb';
import OutboxStatus from '@/components/pwa/OutboxStatus';

type DayJob = { id: string; startAt: string | null; endAt: string | null; reg: string; customer: string; resourceName: string | null; service: string; status: string; isComeback: boolean; heldOnLift?: boolean };
type DayNote = { id: string; title: string; colour: string | null; startAt: string; endAt: string; resourceId: string | null };
type DayData = { siteId: string | null; siteName?: string; sites: Array<{ id: string; name: string }>; date: string | null; isToday?: boolean; notes?: DayNote[]; onLift?: DayJob[]; booked?: DayJob[] };
type SearchHit = { id: string; reg: string; service: string; status: string; createdAt: string; siteName: string };

const STATUS_TONES: Record<string, string> = {
  in_progress: 'bg-warn-soft text-warn border-warn',
  done: 'bg-ok-soft text-ok border-ok',
  paid: 'bg-ok-soft text-ok border-ok',
  invoiced: 'bg-accent-soft text-accent border-accent',
  declined: 'bg-danger-soft text-danger border-danger',
  cancelled: 'bg-danger-soft text-danger border-danger',
};
// The status colour bar down the row's left edge — same semantic palette as the chips.
const STATUS_BAR: Record<string, string> = {
  in_progress: 'var(--warn)',
  done: 'var(--ok)',
  paid: 'var(--ok)',
  invoiced: 'var(--accent)',
  declined: 'var(--danger)',
  cancelled: 'var(--danger)',
};

const dayShift = (dateStr: string, days: number) => {
  const d = new Date(`${dateStr}T00:00:00Z`);
  return new Date(d.getTime() + days * 86_400_000).toISOString().slice(0, 10);
};

export default function MobileDiaryDay() {
  const { t } = useTranslation('pwa');
  const [data, setData] = useState<DayData | null>(null);
  const [net, setNet] = useState<'loading' | 'fresh' | 'offline'>('loading');
  const [site, setSite] = useState<string | null>(null);
  const [date, setDate] = useState<string | null>(null); // null = today (server resolves)
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<SearchHit[] | null>(null); // null = not searching

  const load = useCallback(async (siteOverride?: string | null, dateOverride?: string | null) => {
    const chosenSite = siteOverride !== undefined ? siteOverride : site;
    const chosenDate = dateOverride !== undefined ? dateOverride : date;
    const params = new URLSearchParams();
    if (chosenSite) params.set('site', chosenSite);
    if (chosenDate) params.set('date', chosenDate);
    const qs = params.toString();
    try {
      const res = await fetch(`/api/pwa/day${qs ? `?${qs}` : ''}`, { cache: 'no-store' });
      if (!res.ok) throw new Error(String(res.status));
      const fresh = (await res.json()) as DayData;
      setData(fresh);
      setNet('fresh');
      cachePut(`day:${fresh.date ?? 'today'}`, fresh); // last-known, per calendar day
      if (fresh.isToday) cachePut('day:today', fresh);
      if (fresh.siteId) try { localStorage.setItem('gd-m-site', fresh.siteId); } catch { /* pref only */ }
    } catch {
      setNet('offline'); // keep whatever is rendered — never a blocking state
      const cached = await cacheGet<DayData>(`day:${chosenDate ?? 'today'}`);
      if (cached) setData(cached.value);
    }
  }, [site, date]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const cached = await cacheGet<DayData>('day:today');
      if (cached && !cancelled) setData(cached.value); // instant paint from last-known
      let pref: string | null = null;
      try { pref = localStorage.getItem('gd-m-site'); } catch { /* cold */ }
      if (!cancelled) { setSite(pref); await load(pref, null); }
    })();
    const onWake = () => load();
    window.addEventListener('online', onWake);
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') onWake(); });
    return () => { cancelled = true; window.removeEventListener('online', onWake); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Reg search — the standing escape hatch. Debounced; quiet offline.
  useEffect(() => {
    const term = q.replace(/\s+/g, '');
    if (term.length < 2) { setHits(null); return; }
    const h = setTimeout(async () => {
      try {
        const res = await fetch(`/api/pwa/search?q=${encodeURIComponent(term)}`, { cache: 'no-store' });
        if (res.ok) setHits(((await res.json()).results ?? []) as SearchHit[]);
      } catch { setHits([]); }
    }, 250);
    return () => clearTimeout(h);
  }, [q]);

  const hhmm = (iso: string | null) => iso ? new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/London' }) : '—';
  const chipTone = (s: string) => STATUS_TONES[s] ?? 'bg-surface-muted text-muted border-line';
  const barTone = (s: string) => STATUS_BAR[s] ?? 'var(--border)';
  const nav = (delta: number) => { if (!data?.date) return; const next = dayShift(data.date, delta); setDate(next); load(undefined, next); };
  const goToday = () => { setDate(null); load(undefined, null); };
  const dayLabel = data?.date
    ? new Date(`${data.date}T00:00:00Z`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' })
    : '…';

  const JobRow = ({ j, showTime }: { j: DayJob; showTime: boolean }) => (
    <li>
      <Link href={`/m/job/${j.id}`} className="bg-surface border border-line rounded-xl pr-3 py-3 min-h-[56px] flex items-center gap-3 overflow-hidden active:bg-surface-muted"
        style={{ borderLeft: `4px solid ${barTone(j.status)}` }}>
        {showTime && <span className="text-sm font-semibold text-ink tabular-nums w-12 shrink-0 pl-2">{hhmm(j.startAt)}</span>}
        <span className={`min-w-0 flex-1 ${showTime ? '' : 'pl-3'}`}>
          <span className="block text-base font-bold text-ink">{j.reg}</span>
          <span className="block text-xs text-muted truncate">{j.customer}{j.resourceName ? ` · ${j.resourceName}` : ''}</span>
          {j.service && <span className="block text-xs text-muted truncate">{j.service}</span>}
        </span>
        {j.heldOnLift && j.status !== 'in_progress' && (
          <span className="shrink-0 text-[11px] font-semibold rounded-full border border-warn bg-warn-soft text-warn px-2 py-1">{t('heldOnLift')}</span>
        )}
        <span className={`shrink-0 text-[11px] font-semibold rounded-full border px-2 py-1 ${chipTone(j.status)}`}>
          {t(`status.${j.status}`)}
        </span>
      </Link>
    </li>
  );

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
              <h1 className="text-base font-bold">{data?.siteName || t('title')}</h1>
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
          {/* Day navigation — ← date → and Today. */}
          <div className="flex items-center gap-2 mt-2">
            <button onClick={() => nav(-1)} aria-label={t('prevDay')} className="min-h-[44px] min-w-[44px] rounded-lg text-lg" style={{ background: '#1C3257' }}>←</button>
            <span className="flex-1 text-center text-sm font-semibold">{dayLabel}</span>
            <button onClick={() => nav(1)} aria-label={t('nextDay')} className="min-h-[44px] min-w-[44px] rounded-lg text-lg" style={{ background: '#1C3257' }}>→</button>
            {!data?.isToday && (
              <button onClick={goToday} className="min-h-[44px] rounded-lg px-3 text-sm font-semibold" style={{ background: '#2563EB' }}>{t('today')}</button>
            )}
          </div>
        </header>
        <OutboxStatus />

        <main className="p-3 space-y-3">
          {/* Reg search — always present, so no state is ever a dead end. */}
          <input
            type="search"
            inputMode="text"
            autoCapitalize="characters"
            autoCorrect="off"
            spellCheck={false}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={t('searchPlaceholder')}
            aria-label={t('searchPlaceholder')}
            className="w-full min-h-[48px] bg-surface border border-line rounded-xl px-4 text-base text-ink"
          />

          {hits != null ? (
            hits.length === 0 ? (
              <p className="text-sm text-muted p-2">{t('searchNoResults', { q })}</p>
            ) : (
              <ul className="space-y-2">
                {hits.map((j) => (
                  <li key={j.id}>
                    <Link href={`/m/job/${j.id}`} className="bg-surface border border-line rounded-xl px-3 py-3 min-h-[56px] flex items-center gap-3 active:bg-surface-muted">
                      <span className="min-w-0 flex-1">
                        <span className="block text-sm font-bold text-ink">{j.reg}</span>
                        <span className="block text-xs text-muted truncate">{j.service || j.createdAt}{j.siteName ? ` · ${j.siteName}` : ''}</span>
                      </span>
                      <span className={`shrink-0 text-[11px] font-semibold rounded-full border px-2 py-1 ${chipTone(j.status)}`}>
                        {t(`status.${j.status}`)}
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            )
          ) : data == null ? (
            <p className="text-sm text-muted p-2">{t('updating')}</p>
          ) : (
            <>
              {/* Day notes — the diary's block, verbatim: the highest-value line on this screen. */}
              {(data.notes?.length ?? 0) > 0 && (
                <section className="bg-surface border border-line rounded-xl p-3">
                  <h2 className="text-xs font-semibold text-muted uppercase tracking-wide mb-1.5">{t('dayNotes')}</h2>
                  <ul className="space-y-1.5">
                    {data.notes!.map((n) => (
                      <li key={n.id} className="flex items-start gap-2 text-sm text-ink">
                        <span className="mt-1 w-2.5 h-2.5 rounded-full shrink-0" style={{ background: n.colour || 'var(--accent)' }} />
                        <span className="min-w-0">
                          <span className="font-medium">{n.title}</span>
                          <span className="text-xs text-muted"> · {hhmm(n.startAt)}–{hhmm(n.endAt)}</span>
                        </span>
                      </li>
                    ))}
                  </ul>
                </section>
              )}

              {(data.onLift?.length ?? 0) > 0 && (
                <section>
                  <h2 className="text-xs font-semibold text-muted uppercase tracking-wide px-1 mb-1.5">{t('onLiftNow')}</h2>
                  <ul className="space-y-2">
                    {data.onLift!.map((j) => <JobRow key={j.id} j={j} showTime={false} />)}
                  </ul>
                </section>
              )}

              {(data.booked?.length ?? 0) > 0 ? (
                <section>
                  <h2 className="text-xs font-semibold text-muted uppercase tracking-wide px-1 mb-1.5">{data.isToday === false ? t('bookedOn', { date: dayLabel }) : t('bookedToday')}</h2>
                  <ul className="space-y-2">
                    {data.booked!.map((j) => <JobRow key={j.id} j={j} showTime />)}
                  </ul>
                </section>
              ) : (data.onLift?.length ?? 0) === 0 ? (
                /* Named, dated, never a dead end (the search sits above). Site name from DATA. */
                <p className="text-sm text-muted p-2">
                  {t('emptyDay', {
                    site: data.siteName || '—',
                    date: data.date ? new Date(`${data.date}T00:00:00Z`).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' }) : '',
                  })}
                </p>
              ) : null}
            </>
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
