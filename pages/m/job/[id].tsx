/**
 * File: pages/m/job/[id].tsx
 * The phone job card: customer · vehicle · work sold · notes · stage photos — plus the TWO
 * bay-side facts only the person at the car can capture: VIN (off the scuttle) and mileage (off
 * the dash), written through the EXISTING vehicle-facts path via the outbox (kind:'vehicle' —
 * the second proof the envelope generalises). NO MONEY on this surface, any role — the endpoint
 * carries none. Nothing else writes: no status, no notes, no clock. CACHE-FIRST like My Day — the card TEXT paints
 * instantly from IndexedDB in a dead-signal bay; photo thumbnails lazy-load live (their presigned
 * URLs expire, so they are never cached). VIN is the anchor grain a mechanic reads to a parts
 * factor while standing at the car: rendered BIG, tap-to-copy. Money arrives pre-shaped by the
 * server (financeVisibility) — this page renders what it was sent and nothing more.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import Head from 'next/head';
import Link from 'next/link';
import { useRouter } from 'next/router';
import { getServerSession } from 'next-auth';
import { useTranslation } from 'next-i18next';
import { authOptions } from '@/pages/api/auth/[...nextauth]';
import { withI18n } from '@/lib/gssp-i18n';
import { cacheGet, cachePut } from '@/lib/pwa-idb';
import { resizeImage } from '@/lib/image-resize';
import { enqueuePhoto, enqueueVehicle, outboxAll, retryItem, discardItem, subscribeOutbox, OutboxItem } from '@/lib/pwa-outbox';
import OutboxStatus from '@/components/pwa/OutboxStatus';

type JobLine = { type: string; description: string; qty: string; hours: number | null };
type JobData = {
  id: string; status: string; isComeback: boolean;
  customer: { name: string; phone: string | null };
  vehicle: { registration: string; make: string | null; model: string | null; colour: string | null; vin: string | null; mileageIn: number | null };
  lines: JobLine[]; notes: string; invoice: { number: string; status: string } | null;
  currency: string; locale: string;
};
type StagePhoto = { id: string; stage: string; mediaType: 'photo' | 'video'; url: string | null; label: string | null };
// A capture living on THIS phone = an OUTBOX row (IndexedDB-first: an OS-killed app loses
// nothing). Thumbnails render from the queued blobs; failure is a STATE on the thumbnail
// (tap retries, explicit discard), never an error dialogue.
type LocalShot = { photoId: string; url: string; state: 'pending' | 'failed'; lastError: string | null };

const STAGES = ['intake', 'injob', 'completion'] as const;

export default function MobileJobCard() {
  const { t } = useTranslation('pwa');
  const router = useRouter();
  const id = typeof router.query.id === 'string' ? router.query.id : '';
  const [job, setJob] = useState<JobData | null>(null);
  const [net, setNet] = useState<'loading' | 'fresh' | 'offline'>('loading');
  const [photos, setPhotos] = useState<StagePhoto[] | null>(null); // null = not loaded (offline/laggy) — text never waits on these
  const [copied, setCopied] = useState(false);
  const [shots, setShots] = useState<Record<string, LocalShot[]>>({}); // per-stage local captures
  // Bay-side fact editors. null = closed; string = the in-progress value.
  const [vinEdit, setVinEdit] = useState<string | null>(null);
  const [vinErr, setVinErr] = useState(false);
  const [milesEdit, setMilesEdit] = useState<string | null>(null);
  const [milesWarnLow, setMilesWarnLow] = useState(false); // lower-than-recorded needs a second, explicit tap
  const fileRefs = useRef<Record<string, HTMLInputElement | null>>({});

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

  const refreshPhotos = useCallback(async () => {
    try {
      const pr = await fetch(`/api/photos?jobCardId=${encodeURIComponent(id)}`, { cache: 'no-store' });
      if (pr.ok) setPhotos(((await pr.json()).photos ?? []) as StagePhoto[]);
    } catch { /* quiet */ }
  }, [id]);

  // Pending thumbnails = THIS card's outbox rows (IndexedDB) — they survive app kills and render
  // on reopen; when the drain sends one, its row vanishes and the server list takes over.
  const loadShots = useCallback(async () => {
    const items = (await outboxAll()).filter((i: OutboxItem) => i.jobCardId === id && i.kind === 'photo' && i.stage && i.blob);
    setShots((prev) => {
      for (const arr of Object.values(prev)) for (const sh of arr) URL.revokeObjectURL(sh.url);
      const next: Record<string, LocalShot[]> = {};
      for (const it of items) {
        (next[it.stage!] ??= []).push({ photoId: it.id, url: URL.createObjectURL(it.blob!), state: it.state === 'failed' ? 'failed' : 'pending', lastError: it.lastError });
      }
      return next;
    });
  }, [id]);

  useEffect(() => {
    if (!id) return;
    loadShots();
    const un = subscribeOutbox(() => { loadShots(); refreshPhotos(); }); // a drained item = a fresh server thumbnail
    return un;
  }, [id, loadShots, refreshPhotos]);

  // Shutter → downscale FIRST (full-size bytes never held) → IDB BEFORE any network → walk away.
  async function onCapture(stage: string, files: FileList | null) {
    if (!files || !files.length) return;
    for (const file of Array.from(files)) {
      if (!file.type.startsWith('image/')) continue;
      const blob = await resizeImage(file); // 1600px/q0.8 — the ONLY size that ever exists from here on
      await enqueuePhoto({ jobCardId: id, stage, blob }); // durably parked, then the drain is invited
    }
    await loadShots();
    const el = fileRefs.current[stage]; if (el) el.value = '';
  }

  function retry(_stage: string, shot: LocalShot) { retryItem(shot.photoId); }
  function discard(shot: LocalShot) { discardItem(shot.photoId).then(loadShots); }

  // VIN: 17 chars, no I/O/Q (they don't exist in VINs — a read error, not a variant).
  const VIN_RE = /^[A-HJ-NPR-Z0-9]{17}$/;
  const applyLocal = (patch: Partial<JobData['vehicle']>) => {
    setJob((j) => {
      if (!j) return j;
      const next = { ...j, vehicle: { ...j.vehicle, ...patch } };
      cachePut(`job:${id}`, next); // the bay is often offline — the cached card shows what was queued
      return next;
    });
  };

  async function saveVin() {
    const vin = (vinEdit ?? '').replace(/\s+/g, '').toUpperCase();
    if (!VIN_RE.test(vin)) { setVinErr(true); return; }
    setVinErr(false); setVinEdit(null);
    applyLocal({ vin });
    await enqueueVehicle({ jobCardId: id, vin }); // rides the outbox — a bay has no signal
  }

  async function saveMiles() {
    const n = Number((milesEdit ?? '').replace(/[^\d]/g, ''));
    if (!Number.isInteger(n) || n < 0 || n > 999999) return;
    const last = job?.vehicle.mileageIn;
    if (last != null && n < last && !milesWarnLow) { setMilesWarnLow(true); return; } // warn once, save on the second, deliberate tap
    setMilesWarnLow(false); setMilesEdit(null);
    applyLocal({ mileageIn: n });
    await enqueueVehicle({ jobCardId: id, mileageIn: n });
  }

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
        <OutboxStatus />

        <main className="p-3 space-y-3 pb-8">
          {job == null ? (
            <p className="text-sm text-muted p-2">{net === 'offline' ? t('offlineNoCache') : t('updating')}</p>
          ) : (
            <>
              {/* Vehicle — VIN is the hero: big, tap-to-copy (parts-factor-on-the-phone grain). */}
              <section className="bg-surface border border-line rounded-xl p-4">
                <h2 className="text-xs font-semibold text-muted uppercase tracking-wide mb-2">{t('vehicle')}</h2>
                <p className="text-sm text-ink">{[job.vehicle.make, job.vehicle.model].filter(Boolean).join(' ') || '—'}{job.vehicle.colour ? ` · ${job.vehicle.colour}` : ''}</p>

                {/* Mileage — the dash is in front of the mechanic; a LOWER value than recorded
                    needs a second, explicit tap (fat-fingered 40,000 into a 140,000 car corrupts
                    history quietly). */}
                {milesEdit == null ? (
                  <p className="text-sm text-muted mt-0.5 min-h-[44px] flex items-center gap-2">
                    <span>{t('mileage')}: {job.vehicle.mileageIn != null ? job.vehicle.mileageIn.toLocaleString('en-GB') : '—'}</span>
                    <button onClick={() => { setMilesEdit(job.vehicle.mileageIn != null ? String(job.vehicle.mileageIn) : ''); setMilesWarnLow(false); }} className="text-accent underline text-sm min-h-[44px]">{job.vehicle.mileageIn != null ? t('edit') : t('addMileage')}</button>
                  </p>
                ) : (
                  <div className="mt-2">
                    <input
                      type="text" inputMode="numeric" autoComplete="off"
                      value={milesEdit}
                      onChange={(e) => { setMilesEdit(e.target.value.replace(/[^\d]/g, '')); setMilesWarnLow(false); }}
                      aria-label={t('mileage')}
                      className="w-full min-h-[48px] bg-surface border border-line rounded-lg px-3 text-base text-ink tabular-nums"
                    />
                    {milesWarnLow && <p className="text-xs text-warn mt-1">{t('mileageLowWarn', { last: (job.vehicle.mileageIn ?? 0).toLocaleString('en-GB') })}</p>}
                    <div className="flex gap-2 mt-2">
                      <button onClick={saveMiles} className="min-h-[44px] rounded-lg px-4 text-sm font-semibold bg-accent text-white">{milesWarnLow ? t('saveAnyway') : t('save')}</button>
                      <button onClick={() => { setMilesEdit(null); setMilesWarnLow(false); }} className="min-h-[44px] rounded-lg px-4 text-sm text-muted">{t('cancel')}</button>
                    </div>
                  </div>
                )}

                {/* VIN — the scuttle is in front of the mechanic. Uppercase keyboard, no autocorrect;
                    strict 17 chars, no I/O/Q. */}
                {vinEdit != null ? (
                  <div className="mt-3">
                    <input
                      type="text" autoCapitalize="characters" autoCorrect="off" spellCheck={false} autoComplete="off" maxLength={17}
                      value={vinEdit}
                      onChange={(e) => { setVinEdit(e.target.value.toUpperCase()); setVinErr(false); }}
                      placeholder={t('vinPlaceholder')}
                      aria-label={t('vin')}
                      className="w-full min-h-[48px] bg-surface border border-line rounded-lg px-3 text-base font-bold tracking-wider text-ink"
                    />
                    {vinErr && <p className="text-xs text-danger mt-1">{t('vinInvalid')}</p>}
                    <div className="flex gap-2 mt-2">
                      <button onClick={saveVin} className="min-h-[44px] rounded-lg px-4 text-sm font-semibold bg-accent text-white">{t('save')}</button>
                      <button onClick={() => { setVinEdit(null); setVinErr(false); }} className="min-h-[44px] rounded-lg px-4 text-sm text-muted">{t('cancel')}</button>
                    </div>
                  </div>
                ) : job.vehicle.vin ? (
                  <div className="mt-3">
                    <button
                      onClick={() => copyVin(job.vehicle.vin!)}
                      className="w-full text-left bg-surface-muted border border-line rounded-lg p-3 min-h-[56px]"
                      aria-label={t('copyVin')}
                    >
                      <span className="block text-[10px] font-semibold text-muted uppercase tracking-wide">{t('vin')}</span>
                      <span className="block text-lg font-bold text-ink tracking-wider break-all tabular-nums">{job.vehicle.vin}</span>
                      <span className="block text-xs mt-0.5" style={{ color: copied ? 'var(--ok)' : 'var(--accent)' }}>{copied ? t('copied') : t('copyVin')}</span>
                    </button>
                    <button onClick={() => setVinEdit(job.vehicle.vin ?? '')} className="text-accent underline text-sm min-h-[44px]">{t('editVin')}</button>
                  </div>
                ) : (
                  <button onClick={() => setVinEdit('')} className="mt-3 w-full text-left bg-surface-muted border border-line rounded-lg p-3 min-h-[56px]">
                    <span className="block text-[10px] font-semibold text-muted uppercase tracking-wide">{t('vin')}</span>
                    <span className="block text-sm text-accent underline">{t('addVin')}</span>
                  </button>
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
                const mine = shots[stage] ?? [];
                return (
                  <section key={stage} className="bg-surface border border-line rounded-xl p-4">
                    <div className="flex items-center justify-between mb-2">
                      <h2 className="text-xs font-semibold text-muted uppercase tracking-wide">{t(`photoStage.${stage}`)} {photos != null && <span className="text-muted font-normal">({st.length + mine.length})</span>}</h2>
                      {/* Tap 2 of two: opens the NATIVE camera directly — no picker modal, no confirm. */}
                      <input ref={(el) => { fileRefs.current[stage] = el; }} type="file" accept="image/*" capture="environment" multiple className="hidden" onChange={(e) => onCapture(stage, e.target.files)} />
                      <button onClick={() => fileRefs.current[stage]?.click()} className="min-h-[44px] text-sm font-semibold bg-accent text-white rounded-lg px-4" aria-label={t('addPhoto')}>
                        {t('addPhoto')}
                      </button>
                    </div>
                    {(photos == null && mine.length === 0) ? (
                      <p className="text-xs text-muted">{net === 'offline' ? t('photosOffline') : t('updating')}</p>
                    ) : (st.length === 0 && mine.length === 0) ? (
                      <p className="text-xs text-muted">{t('noPhotos')}</p>
                    ) : (
                      <div className="grid grid-cols-3 gap-2">
                        {mine.map((sh) => (
                          <span key={sh.photoId} className="relative block">
                            <button onClick={() => sh.state === 'failed' && retry(stage, sh)} className="block w-full" aria-label={sh.state === 'failed' ? t('sendFailedRetry') : t('pendingSend')}>
                              <img src={sh.url} alt="" className={`w-full aspect-square object-cover rounded-lg border ${sh.state === 'failed' ? 'border-danger' : 'border-line'} ${sh.state === 'pending' ? 'opacity-70' : ''}`} />
                              <span className={`absolute bottom-1 left-1 right-1 text-center text-[10px] font-semibold rounded px-1 py-0.5 ${sh.state === 'failed' ? 'bg-danger-soft text-danger' : 'bg-surface/90 text-muted'}`}>
                                {sh.state === 'failed' ? t('sendFailedRetry') : t('pendingSend')}
                              </span>
                            </button>
                            {sh.state === 'failed' && (
                              /* Explicit discard — a permanently failed photo never vanishes on its own. */
                              <button onClick={() => discard(sh)} aria-label={t('discard')} className="absolute top-1 right-1 w-7 h-7 rounded-full bg-danger text-white text-xs font-bold">✕</button>
                            )}
                          </span>
                        ))}
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
