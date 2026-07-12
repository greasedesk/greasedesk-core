/**
 * File: pages/m/job/[id].tsx
 * The phone job card, READ-ONLY (PWA build step 4): customer · vehicle · work sold · notes ·
 * stage photos. Nothing on this surface writes. CACHE-FIRST like My Day — the card TEXT paints
 * instantly from IndexedDB in a dead-signal bay; photo thumbnails lazy-load live (their presigned
 * URLs expire, so they are never cached). VIN is the anchor grain a mechanic reads to a parts
 * factor while standing at the car: rendered BIG, tap-to-copy. Money arrives pre-shaped by the
 * server (financeVisibility) — this page renders what it was sent and nothing more.
 */
import { useCallback, useEffect, useState } from 'react';
import Head from 'next/head';
import Link from 'next/link';
import { useRouter } from 'next/router';
import { getServerSession } from 'next-auth';
import { useTranslation } from 'next-i18next';
import { authOptions } from '@/pages/api/auth/[...nextauth]';
import { withI18n } from '@/lib/gssp-i18n';
import { cacheGet, cachePut } from '@/lib/pwa-idb';

type JobLine = { type: string; description: string; qty: string; hours: number | null; unitPrice?: string };
type JobData = {
  id: string; status: string; isComeback: boolean; priceVisible: boolean;
  customer: { name: string; phone: string | null };
  vehicle: { registration: string; make: string | null; model: string | null; colour: string | null; vin: string | null; mileageIn: number | null };
  lines: JobLine[]; notes: string; invoice: { number: string; status: string } | null;
  currency: string; locale: string;
};
type StagePhoto = { id: string; stage: string; mediaType: 'photo' | 'video'; url: string | null; label: string | null };

const STAGES = ['intake', 'injob', 'completion'] as const;

export default function MobileJobCard() {
  const { t } = useTranslation('pwa');
  const router = useRouter();
  const id = typeof router.query.id === 'string' ? router.query.id : '';
  const [job, setJob] = useState<JobData | null>(null);
  const [net, setNet] = useState<'loading' | 'fresh' | 'offline'>('loading');
  const [photos, setPhotos] = useState<StagePhoto[] | null>(null); // null = not loaded (offline/laggy) — text never waits on these
  const [copied, setCopied] = useState(false);

  const load = useCallback(async () => {
    if (!id) return;
    try {
      const res = await fetch(`/api/pwa/job/${encodeURIComponent(id)}`, { cache: 'no-store' });
      if (!res.ok) throw new Error(String(res.status));
      const fresh = (await res.json()) as JobData;
      setJob(fresh); setNet('fresh');
      cachePut(`job:${id}`, fresh);
    } catch { setNet('offline'); }
    // Photos: lazy + live only (presigned URLs expire — never cached). Failure is quiet.
    try {
      const pr = await fetch(`/api/photos?jobCardId=${encodeURIComponent(id)}`, { cache: 'no-store' });
      if (pr.ok) setPhotos(((await pr.json()).photos ?? []) as StagePhoto[]);
    } catch { /* offline — text stands alone */ }
  }, [id]);

  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    (async () => {
      const cached = await cacheGet<JobData>(`job:${id}`);
      if (cached && !cancelled) setJob(cached.value); // instant paint from last-known
      await load();
    })();
    return () => { cancelled = true; };
  }, [id, load]);

  async function copyVin(vin: string) {
    try {
      await navigator.clipboard.writeText(vin);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch { /* clipboard denied — the VIN is still on screen */ }
  }

  return (
    <>
      <Head>
        <title>{job?.vehicle.registration ?? t('title')} - GreaseDesk</title>
        <link rel="manifest" href="/manifest.webmanifest" />
        <meta name="theme-color" content="#0B1E3B" />
        <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
      </Head>
      <div className="min-h-screen" style={{ background: 'var(--content-bg)' }}>
        <header className="px-4 py-3" style={{ background: '#0B1E3B', color: '#FFFFFF', paddingTop: 'max(0.75rem, env(safe-area-inset-top))' }}>
          <div className="flex items-center gap-3">
            <Link href="/m" aria-label={t('back')} className="min-h-[44px] min-w-[44px] flex items-center justify-center rounded-lg text-lg" style={{ background: '#1C3257' }}>←</Link>
            <div className="min-w-0">
              <h1 className="text-base font-bold truncate">{job?.vehicle.registration ?? '…'}</h1>
              <p className="text-xs" style={{ color: '#C7D2E1' }}>
                {net === 'offline' ? t('offline') : net === 'fresh' ? t('updated') : t('updating')}
              </p>
            </div>
            {job && (
              <span className="ml-auto shrink-0 text-[11px] font-semibold rounded-full px-2 py-1" style={{ background: '#1C3257', color: '#FFFFFF' }}>
                {t(`status.${job.status}`)}
              </span>
            )}
          </div>
        </header>

        <main className="p-3 space-y-3 pb-8">
          {job == null ? (
            <p className="text-sm text-muted p-2">{net === 'offline' ? t('offlineNoCache') : t('updating')}</p>
          ) : (
            <>
              {/* Vehicle — VIN is the hero: big, tap-to-copy (parts-factor-on-the-phone grain). */}
              <section className="bg-surface border border-line rounded-xl p-4">
                <h2 className="text-xs font-semibold text-muted uppercase tracking-wide mb-2">{t('vehicle')}</h2>
                <p className="text-sm text-ink">{[job.vehicle.make, job.vehicle.model].filter(Boolean).join(' ') || '—'}{job.vehicle.colour ? ` · ${job.vehicle.colour}` : ''}</p>
                {job.vehicle.mileageIn != null && <p className="text-sm text-muted mt-0.5">{t('mileage')}: {job.vehicle.mileageIn.toLocaleString('en-GB')}</p>}
                {job.vehicle.vin ? (
                  <button
                    onClick={() => copyVin(job.vehicle.vin!)}
                    className="mt-3 w-full text-left bg-surface-muted border border-line rounded-lg p-3 min-h-[56px]"
                    aria-label={t('copyVin')}
                  >
                    <span className="block text-[10px] font-semibold text-muted uppercase tracking-wide">{t('vin')}</span>
                    <span className="block text-lg font-bold text-ink tracking-wider break-all tabular-nums">{job.vehicle.vin}</span>
                    <span className="block text-xs mt-0.5" style={{ color: copied ? 'var(--ok)' : 'var(--accent)' }}>{copied ? t('copied') : t('copyVin')}</span>
                  </button>
                ) : (
                  <p className="text-sm text-muted mt-2">{t('noVin')}</p>
                )}
              </section>

              {/* Customer */}
              <section className="bg-surface border border-line rounded-xl p-4">
                <h2 className="text-xs font-semibold text-muted uppercase tracking-wide mb-2">{t('customer')}</h2>
                <p className="text-sm font-medium text-ink">{job.customer.name}</p>
                {job.customer.phone && <a href={`tel:${job.customer.phone}`} className="inline-block mt-1 text-sm text-accent underline min-h-[44px] leading-[44px]">{job.customer.phone}</a>}
              </section>

              {/* Work sold — read-only lines; prices only if the server sent them. */}
              <section className="bg-surface border border-line rounded-xl p-4">
                <h2 className="text-xs font-semibold text-muted uppercase tracking-wide mb-2">{t('workSold')}</h2>
                {job.isComeback && <p className="text-xs font-semibold text-warn mb-2">{t('warrantyJob')}</p>}
                {job.lines.length === 0 ? (
                  <p className="text-sm text-muted">{t('noLines')}</p>
                ) : (
                  <ul className="divide-y divide-line/60">
                    {job.lines.map((l, i) => (
                      <li key={i} className="py-2 flex items-start gap-2">
                        <span className="min-w-0 flex-1">
                          <span className="block text-sm text-ink whitespace-pre-line">{l.description || '—'}</span>
                          <span className="block text-xs text-muted">
                            {l.type === 'labour' ? t('lineHours', { hours: l.qty }) : t('lineQty', { qty: l.qty })}
                            {l.hours != null ? ` · ${t('lineHours', { hours: String(l.hours) })}` : ''}
                          </span>
                        </span>
                        {l.unitPrice !== undefined && <span className="shrink-0 text-sm text-ink tabular-nums">£{l.unitPrice}</span>}
                      </li>
                    ))}
                  </ul>
                )}
                {job.invoice && <p className="text-xs text-muted mt-2">{t('invoiceLabel', { number: job.invoice.number })}</p>}
              </section>

              {/* Notes */}
              {job.notes && (
                <section className="bg-surface border border-line rounded-xl p-4">
                  <h2 className="text-xs font-semibold text-muted uppercase tracking-wide mb-2">{t('notes')}</h2>
                  <p className="text-sm text-ink whitespace-pre-line">{job.notes}</p>
                </section>
              )}

              {/* Stage photos — lazy, live-only thumbnails; capture arrives in step 5. */}
              {STAGES.map((stage) => {
                const st = (photos ?? []).filter((p) => p.stage === stage);
                return (
                  <section key={stage} className="bg-surface border border-line rounded-xl p-4">
                    <h2 className="text-xs font-semibold text-muted uppercase tracking-wide mb-2">{t(`photoStage.${stage}`)} {photos != null && <span className="text-muted font-normal">({st.length})</span>}</h2>
                    {photos == null ? (
                      <p className="text-xs text-muted">{net === 'offline' ? t('photosOffline') : t('updating')}</p>
                    ) : st.length === 0 ? (
                      <p className="text-xs text-muted">{t('noPhotos')}</p>
                    ) : (
                      <div className="grid grid-cols-3 gap-2">
                        {st.map((p) => p.url && (
                          p.mediaType === 'video'
                            ? <video key={p.id} src={p.url} className="w-full aspect-square object-cover rounded-lg border border-line" preload="metadata" controls />
                            : <img key={p.id} src={p.url} alt={p.label ?? ''} loading="lazy" className="w-full aspect-square object-cover rounded-lg border border-line" />
                        ))}
                      </div>
                    )}
                  </section>
                );
              })}
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
  if (!user?.id || !user?.group_id) {
    return { redirect: { destination: `/admin/login?callbackUrl=${encodeURIComponent(ctx.resolvedUrl)}`, permanent: false } };
  }
  return { props: {} };
});
